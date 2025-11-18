// ! Arquivo: logisticsAndConfirmationRoutes.js (FINAL CORRIGIDO: Taxa de 8% e Pagamento de Frete Repassado ao Lojista)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protectDeliveryPerson } = require('./deliveryAuthMiddleware');
const { protect } = require('./authMiddleware'); 

// --- Constantes Comuns (Taxa de 8%) ---
const MARKETPLACE_FEE_RATE = 0.08; // CORREÇÃO: Taxa de 8% (Repasse do Frete ao Lojista)
const DELIVERY_FEE = 5.00;         // R$ 5,00 (Mantido, representa o custo de frete do cliente, que é repassado)


// ===================================================================
// ROTAS DO ENTREGADOR
// ===================================================================

/**
 * Rota 4: Entregador: Lista Pedidos Disponíveis (GET /api/delivery/available)
 */
router.get('/available', protectDeliveryPerson, async (req, res) => {
    const entregadorId = req.user.id;
    if (req.user.is_available === 0) {
         return res.status(200).json({ success: true, message: 'Você está ocupado no momento.', orders: [] });
    }
    
    try {
        const [availableOrders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.delivery_code, o.delivery_pickup_code,
                s.name AS store_name, u.full_name AS buyer_name
             FROM orders o
             JOIN deliveries d ON o.id = d.order_id
             JOIN stores s ON o.store_id = s.id
             JOIN users u ON o.buyer_id = u.id
             WHERE o.status = 'Delivering' 
               AND d.delivery_person_id IS NULL 
               AND d.status = 'Requested'
               AND o.delivery_method = 'Marketplace'
             ORDER BY o.created_at ASC`
        );
        
        res.status(200).json({ success: true, orders: availableOrders });
    } catch (error) {
        console.error('[DELIVERY/AVAILABLE] Erro ao listar pedidos:', error);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});

/**
 * Rota 5: Entregador: Aceitar Pedido (PUT /api/delivery/accept/:orderId)
 */
router.put('/accept/:orderId', protectDeliveryPerson, async (req, res) => {
    const orderId = req.params.orderId;
    const entregadorId = req.user.id;

    if (req.user.is_available === 0) {
        return res.status(400).json({ success: false, message: 'Você já está com uma entrega pendente.' });
    }

    try {
        await pool.query('BEGIN');

        // Aceita se estiver 'Requested' e sem entregador atribuído (Marketplace)
        const [deliveryUpdate] = await pool.execute(
            `UPDATE deliveries SET delivery_person_id = ?, status = 'Accepted' 
             WHERE order_id = ? AND status = 'Requested' AND delivery_person_id IS NULL`,
            [entregadorId, orderId]
        );
        
        if (deliveryUpdate.affectedRows === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Pedido não disponível ou já aceito.' });
        }
        
        // Busca o código de retirada gerado no pedido (o.delivery_pickup_code) para retornar ao entregador
        const [order] = await pool.execute('SELECT delivery_pickup_code FROM orders WHERE id = ?', [orderId]);
        const pickupCode = order[0]?.delivery_pickup_code;
        
        await pool.execute('UPDATE users SET is_available = FALSE WHERE id = ?', [entregadorId]);

        await pool.query('COMMIT');
        // Retorna o pickupCode para que o frontend do entregador possa exibí-lo
        res.status(200).json({ 
            success: true, 
            message: 'Pedido aceito! Apresente o código de retirada na loja.', 
            delivery_pickup_code: pickupCode 
        });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/ACCEPT] Erro ao aceitar pedido:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao aceitar pedido.' });
    }
});

/**
 * Rota 11: Entregador: Ver Entrega Atual (GET /api/delivery/current)
 * CORREÇÃO: Incluído WhatsApp e Itens do Pedido.
 */
router.get('/current', protectDeliveryPerson, async (req, res) => {
    const entregadorId = req.user.id;
    
    // Se o usuário estiver disponível (is_available = 1), não há entrega ativa.
    if (req.user.is_available) {
         return res.status(200).json({ success: true, delivery: null });
    }
    
    try {
        const [deliveryRows] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.delivery_pickup_code, 
                u.full_name AS buyer_name, 
                s.name AS store_name, CONCAT(s.address_street, ', ', s.address_number) AS store_address, 
                d.delivery_time, d.pickup_time, d.packing_start_time, d.delivery_person_id,
                d.status AS delivery_status, 
                CONCAT(
                    o.delivery_address_street, ', ', o.delivery_address_number, 
                    ' (Ref: ', COALESCE(o.delivery_address_nearby, 'N/A'), ')'
                ) AS delivery_address,
                -- ! ADICIONADO: WhatsApp do Comprador
                o.buyer_whatsapp_number 
             FROM deliveries d
             JOIN orders o ON d.order_id = o.id
             JOIN stores s ON o.store_id = s.id
             JOIN users u ON o.buyer_id = u.id
             WHERE d.delivery_person_id = ? 
               AND o.status = 'Delivering' 
             LIMIT 1`,
            [entregadorId]
        );
        
        const delivery = deliveryRows[0] || null;

        if (delivery) {
             // ! ADICIONADO: Busca os itens do pedido (para nome, quantidade e atributos)
             const [items] = await pool.execute(
                 `SELECT product_name, quantity, attributes_json 
                  FROM order_items WHERE order_id = ?`, 
                 [delivery.id]
             );

             return res.status(200).json({ success: true, delivery: {
                 order: { 
                     id: delivery.id, 
                     total_amount: delivery.total_amount, 
                     store_name: delivery.store_name,
                     store_address: delivery.store_address, 
                     buyer_name: delivery.buyer_name,
                     delivery_address: delivery.delivery_address, 
                     // ! INCLUI O WHATSAPP NO RETORNO
                     buyer_whatsapp_number: delivery.buyer_whatsapp_number, 
                     // ! INCLUI OS ITENS
                     items: items 
                 },
                 delivery_pickup_code: delivery.delivery_pickup_code, 
                 status: delivery.delivery_status, 
             } });
        } else {
             // Sincronização: se ele deveria estar ocupado, mas não está em um pedido "Delivering",
             // provavelmente a entrega foi concluída. Marque como disponível.
             if (!req.user.is_available) {
                  await pool.execute('UPDATE users SET is_available = TRUE WHERE id = ?', [entregadorId]);
             }
             return res.status(200).json({ success: true, delivery: null, message: "Nenhuma entrega ativa encontrada. Status resetado." });
        }
    } catch (error) {
        console.error('[DELIVERY/CURRENT] Erro ao buscar entrega atual:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar entrega atual.' });
    }
});


// ===================================================================
// ROTA DE CONFIRMAÇÃO E FLUXO FINANCEIRO
// ===================================================================

/**
 * Rota 6: Confirmação de Entrega (POST /api/delivery/confirm)
 * CORRIGIDA: Implementa a lógica de repasse do valor do frete ao lojista,
 * deduzindo apenas a taxa de 8% da plataforma. O lojista é responsável
 * por pagar o entregador, independentemente do delivery_method.
 */
router.post('/confirm', protect, async (req, res) => {
    const userId = req.user.id; 
    const { order_id, confirmation_code } = req.body;

    try {
        await pool.query('BEGIN');
        
        // 1. Busca o pedido, verifica o código e o status 'Delivering'
        const [orderRows] = await pool.execute(
            `SELECT o.*, s.seller_id, s.contracted_delivery_person_id, d.delivery_person_id 
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             WHERE o.id = ? AND o.delivery_code = ? AND o.status = 'Delivering'`,
            [order_id, confirmation_code]
        );

        const order = orderRows[0];
        if (!order) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Código ou pedido inválido.' });
        }

        // Permissão: Apenas Entregador Atribuído OU Lojista fazendo Entrega Própria
        const isDeliveryPersonAssigned = (order.delivery_person_id === userId);
        const isSellerSelfDelivery = (order.delivery_method === 'Seller' && order.seller_id === userId);
        
        if (!isDeliveryPersonAssigned && !isSellerSelfDelivery) {
             await pool.query('ROLLBACK');
             return res.status(403).json({ success: false, message: 'Apenas o entregador atribuído ou o vendedor podem confirmar.' });
        }
        
        let paymentMessage = 'Pagamento em processamento.';
        
        // --- Processamento Financeiro UNIFICADO (Taxa de 8% para a plataforma, restante para o Lojista) ---
        
        // 1. Calcula a taxa da plataforma (8%)
        const marketplaceFee = order.total_amount * MARKETPLACE_FEE_RATE;
        // 2. O lucro do lojista (Inclui o frete para que ele pague o entregador)
        const sellerEarnings = order.total_amount - marketplaceFee; 
        
        // 3. Credita no saldo do Vendedor
        await pool.execute(
            'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
            [sellerEarnings, order.seller_id]
        );
        paymentMessage = `R$${sellerEarnings.toFixed(2)} creditados ao vendedor. O pagamento do entregador é responsabilidade do lojista.`;
        
        // 4. Se a entrega usou o sistema de logística do app (Marketplace ou Contratada) e tinha um entregador, marca ele como DISPONÍVEL
        if ((order.delivery_method === 'Marketplace' || order.delivery_method === 'Contracted') && order.delivery_person_id) {
             await pool.execute('UPDATE users SET is_available = TRUE WHERE id = ?', [order.delivery_person_id]);
        }

        // 5. Atualiza status da entrega e do pedido para finalizado, E REGISTRA O delivery_time
        await pool.execute('UPDATE orders SET status = "Completed" WHERE id = ?', [order_id]);
        await pool.execute(
            'UPDATE deliveries SET status = "Delivered_Confirmed", delivery_time = NOW(), buyer_confirmation_at = NOW() WHERE order_id = ?', 
            [order_id]
        );

        await pool.query('COMMIT');
        res.status(200).json({ success: true, message: `Entrega confirmada. ${paymentMessage}` });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/CONFIRM] Erro ao confirmar entrega:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao confirmar entrega.' });
    }
});


module.exports = router;
