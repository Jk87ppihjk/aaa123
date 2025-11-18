// ! Arquivo: deliveryRoutes.js (VERSÃO FINAL COMPLETA E UNIFICADA - ROTAS 1 a 11)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protectDeliveryPerson } = require('./deliveryAuthMiddleware');
const { protect } = require('./authMiddleware'); 
// O módulo 'simulatePixPayment' deve estar implementado em abacatePayService.js
const { createPixQrCode, simulatePixPayment } = require('./abacatePayService'); 

// --- Constantes de Regras de Negócio ---
const MARKETPLACE_FEE_RATE = 0.05; // 5%
const DELIVERY_FEE = 5.00;         // R$ 5,00


// ===================================================================
// ROTAS DE ADMINISTRAÇÃO E CONTRATO (Usado pelo Seller)
// ===================================================================

/**
 * Rota 1: Contratar ou Demitir Entregador (PUT /api/delivery/contract/:storeId)
 */
router.put('/delivery/contract/:storeId', protectSeller, async (req, res) => {
    const storeId = req.params.storeId;
    const sellerId = req.user.id;
    const { delivery_person_id } = req.body; 

    const [storeCheck] = await pool.execute(
        'SELECT id FROM stores WHERE id = ? AND seller_id = ?',
        [storeId, sellerId]
    );

    if (storeCheck.length === 0) {
        return res.status(403).json({ success: false, message: 'Acesso negado ou loja não encontrada.' });
    }

    try {
        if (delivery_person_id) {
            const [dpCheck] = await pool.execute(
                'SELECT id FROM users WHERE id = ? AND is_delivery_person = TRUE',
                [delivery_person_id]
            );
            if (dpCheck.length === 0) {
                return res.status(400).json({ success: false, message: 'ID fornecido não corresponde a um entregador cadastrado.' });
            }
        }
        
        await pool.execute(
            'UPDATE stores SET contracted_delivery_person_id = ? WHERE id = ?',
            [delivery_person_id || null, storeId]
        );

        const status = delivery_person_id ? 'CONTRATADO' : 'DEMITIDO';
        res.status(200).json({ success: true, message: `Entregador ${status} com sucesso!` });

    } catch (error) {
        console.error('[DELIVERY/CONTRACT] Erro ao gerenciar contrato:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao salvar contrato.' });
    }
});


// ===================================================================
// ROTAS DE PEDIDOS (Comprador/Vendedor)
// ===================================================================

/**
 * Rota 2: Cria um NOVO Pedido (POST /api/delivery/orders) - FLUXO PIX REAL
 */
router.post('/delivery/orders', protect, async (req, res) => {
    const buyerId = req.user.id;
    const { store_id, items, total_amount } = req.body; 

    if (!store_id || !items || items.length === 0 || !total_amount) {
        return res.status(400).json({ success: false, message: 'Dados do pedido incompletos.' });
    }

    const deliveryCode = Math.random().toString(36).substring(2, 8).toUpperCase(); 
    const amountInCents = Math.round(total_amount * 100);
    const expiresIn = 3600; 
    const description = `Pagamento Pedido ${deliveryCode}`;

    try {
        const pixResult = await createPixQrCode(
            amountInCents, 
            expiresIn, 
            description
        );
        
        // Assumindo que o ID da transação é 'id'
        if (!pixResult.success || !pixResult.qrCodeData.id) { 
             throw new Error('Falha ao gerar o QRCode PIX ou ID da transação ausente.');
        }

        const transactionId = pixResult.qrCodeData.id; 

        await pool.query('BEGIN'); 

        const [orderResult] = await pool.execute(
            `INSERT INTO orders (buyer_id, store_id, total_amount, status, delivery_code, payment_transaction_id) 
             VALUES (?, ?, ?, 'Pending Payment', ?, ?)`,
            [buyerId, store_id, total_amount, deliveryCode, transactionId]
        );
        const orderId = orderResult.insertId;

        // Lógica de diminuição de estoque e inserção de itens aqui...

        await pool.query('COMMIT'); 

        res.status(201).json({ 
            success: true, 
            message: 'Pedido criado com sucesso. O pagamento deve ser feito via PIX.', 
            order_id: orderId,
            pix_qr_code: pixResult.qrCodeData 
        });

    } catch (error) {
        await pool.query('ROLLBACK'); 
        console.error('[DELIVERY/ORDERS] Erro no fluxo do pedido PIX:', error.message);
        
        const status = error.message.includes('QRCode PIX') ? 402 : 500;
        res.status(status).json({ success: false, message: error.message || 'Erro interno ao processar pedido.' });
    }
});


/**
 * Rota 2.5: Cria um NOVO Pedido - FLUXO SIMULADO (POST /api/delivery/orders/simulate-purchase)
 * Cria o pedido diretamente com status 'Processing' (pago).
 */
router.post('/delivery/orders/simulate-purchase', protect, async (req, res) => {
    const buyerId = req.user.id;
    const { store_id, items, total_amount } = req.body; 

    if (!store_id || !items || items.length === 0 || !total_amount) {
        return res.status(400).json({ success: false, message: 'Dados do pedido incompletos.' });
    }

    const deliveryCode = Math.random().toString(36).substring(2, 8).toUpperCase(); 
    const transactionId = 'SIMULATED_PURCHASE'; 
    const simulatedStatus = 'Processing'; 

    try {
        await pool.query('BEGIN'); 

        // 1. Cria o Pedido principal com status 'Processing'
        const [orderResult] = await pool.execute(
            `INSERT INTO orders (buyer_id, store_id, total_amount, status, delivery_code, payment_transaction_id) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [buyerId, store_id, total_amount, simulatedStatus, deliveryCode, transactionId]
        );
        const orderId = orderResult.insertId;

        // 2. Diminui o estoque (Lógica essencial de compra)
        for (const item of items) {
             const [stockUpdate] = await pool.execute(
                'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
                [item.qty, item.id, item.qty]
            );
            if (stockUpdate.affectedRows === 0) {
                 await pool.query('ROLLBACK');
                 return res.status(400).json({ success: false, message: `Estoque insuficiente para o item ID ${item.id}.` });
            }
        }
        
        await pool.query('COMMIT'); 

        res.status(201).json({ 
            success: true, 
            message: 'Pedido simulado criado e pago com sucesso.', 
            order_id: orderId,
            status: simulatedStatus
        });

    } catch (error) {
        await pool.query('ROLLBACK'); 
        console.error('[DELIVERY/SIMULATED] Erro no fluxo do pedido simulado:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Erro interno ao processar pedido simulado.' });
    }
});


/**
 * Rota 3: Vendedor Define Método de Entrega (PUT /api/delivery/orders/:orderId/delivery-method)
 * Usada para definir MarketPlace/Contratado
 */
router.put('/delivery/orders/:orderId/delivery-method', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;
    const { method } = req.body; // 'Seller', 'Contracted', 'Marketplace'

    if (!['Seller', 'Contracted', 'Marketplace'].includes(method)) {
        return res.status(400).json({ success: false, message: 'Método de entrega inválido.' });
    }

    try {
        const [orderCheck] = await pool.execute(
            `SELECT o.store_id, s.contracted_delivery_person_id, o.status 
             FROM orders o 
             JOIN stores s ON o.store_id = s.id 
             WHERE o.id = ? AND s.seller_id = ?`,
            [orderId, sellerId]
        );

        if (orderCheck.length === 0) {
            return res.status(403).json({ success: false, message: 'Acesso negado ou pedido não encontrado.' });
        }
        
        if (orderCheck[0].status !== 'Processing') {
             return res.status(400).json({ success: false, message: 'O pedido não está no status correto ("Processing") para definir o método de entrega.' });
        }

        const store = orderCheck[0];
        let deliveryPersonId = null;

        if (method === 'Contracted') {
            deliveryPersonId = store.contracted_delivery_person_id;
            if (!deliveryPersonId) {
                return res.status(400).json({ success: false, message: 'Loja não possui entregador contratado.' });
            }
        }
        
        // 1. Atualiza status do pedido para Delivering
        await pool.execute(
            'UPDATE orders SET delivery_method = ?, status = "Delivering" WHERE id = ?',
            [method, orderId]
        );
        
        // 2. Se não for 'Seller', cria o registro na tabela 'deliveries'
        if (method !== 'Seller') {
            
            // Adiciona delivery_method na inserção (Correção de schema)
            const [deliveryResult] = await pool.execute(
                `INSERT INTO deliveries (order_id, delivery_person_id, status, delivery_method) VALUES (?, ?, ?, ?)`,
                [orderId, deliveryPersonId, deliveryPersonId ? 'Accepted' : 'Requested', method]
            );

            if (method === 'Contracted' && deliveryPersonId) {
                 await pool.execute('UPDATE users SET is_available = FALSE WHERE id = ?', [deliveryPersonId]);
            }
        }

        res.status(200).json({ success: true, message: `Entrega definida como "${method}".` });

    } catch (error) {
        console.error('[DELIVERY/METHOD] Erro ao definir método de entrega:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao processar a entrega.' });
    }
});


/**
 * Rota 9: Vendedor Despacha o Pedido (PUT /api/delivery/orders/:orderId/dispatch)
 * Usado para Self-Delivery (Eu Entrego).
 */
router.put('/delivery/orders/:orderId/dispatch', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;

    try {
        // 1. Verifica se o pedido é do vendedor e está em 'Processing'
        const [orderCheck] = await pool.execute(
            `SELECT o.id, s.seller_id FROM orders o 
             JOIN stores s ON o.store_id = s.id 
             WHERE o.id = ? AND s.seller_id = ? AND o.status = 'Processing'`,
            [orderId, sellerId]
        );

        if (orderCheck.length === 0) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado, não pertence a você ou não está no status "Processing".' });
        }
        
        // 2. Define o método de entrega como 'Seller' e atualiza o status para 'Delivering'
        await pool.execute(
            "UPDATE orders SET status = 'Delivering', delivery_method = 'Seller' WHERE id = ?",
            [orderId]
        );
        
        // 3. Cria o registro de entrega (Correção de schema)
        await pool.execute(
            `INSERT INTO deliveries (order_id, delivery_person_id, status, delivery_method) 
             VALUES (?, NULL, 'Accepted', 'Seller')`, 
            [orderId]
        );

        res.status(200).json({ success: true, message: 'Pedido despachado! Pronto para a entrega.' });

    } catch (error) {
        console.error('[DELIVERY/DISPATCH] Erro ao despachar pedido:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao despachar.' });
    }
});


// ===================================================================
// ROTAS DE LISTAGEM DE PEDIDOS
// ===================================================================

/**
 * Rota 10: Listar Pedidos da Loja (GET /api/delivery/orders/store/:storeId)
 * USADA PELO painel.html
 */
router.get('/delivery/orders/store/:storeId', protectSeller, async (req, res) => {
    const storeId = req.params.storeId;
    const sellerId = req.user.id;

    // 1. Verificação de Propriedade
    const [storeCheck] = await pool.execute('SELECT seller_id FROM stores WHERE id = ? AND seller_id = ?', [storeId, sellerId]);
    
    if (storeCheck.length === 0) {
        return res.status(403).json({ success: false, message: 'Acesso negado. Esta loja não pertence a você.' });
    }

    try {
        // Junta dados de pedidos, comprador e entregador (se atribuído)
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, o.delivery_code,
                u.full_name AS buyer_name,
                dp.full_name AS delivery_person_name
             FROM orders o
             JOIN users u ON o.buyer_id = u.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             LEFT JOIN users dp ON d.delivery_person_id = dp.id
             WHERE o.store_id = ?
             ORDER BY o.created_at DESC`,
            [storeId]
        );
        
        res.status(200).json({ success: true, orders: orders });

    } catch (error) {
        console.error('[DELIVERY/STORE_ORDERS] Erro ao listar pedidos da loja:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar pedidos.' });
    }
});


/**
 * Rota 11: Comprador lista seus pedidos (GET /api/delivery/orders/mine)
 * USADA PELO my_orders.html
 */
router.get('/delivery/orders/mine', protect, async (req, res) => {
    const buyerId = req.user.id; // User ID do token

    try {
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, o.delivery_code,
                s.name AS store_name,
                dp.full_name AS delivery_person_name
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             LEFT JOIN users dp ON d.delivery_person_id = dp.id
             WHERE o.buyer_id = ?
             ORDER BY o.created_at DESC`,
            [buyerId]
        );

        res.status(200).json({ success: true, orders: orders });

    } catch (error) {
        console.error('[DELIVERY/BUYER_ORDERS] Erro ao listar pedidos do comprador:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar pedidos.' });
    }
});


// ===================================================================
// ROTAS DO ENTREGADOR (deliveryPanel.html)
// ===================================================================

/**
 * Rota 4: Entregador: Lista Pedidos Disponíveis (GET /api/delivery/available)
 */
router.get('/delivery/available', protectDeliveryPerson, async (req, res) => {
    const entregadorId = req.user.id;
    if (req.user.is_available === 0) {
         return res.status(200).json({ success: true, message: 'Você está ocupado no momento.', orders: [] });
    }
    
    try {
        const [availableOrders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.delivery_code, 
                s.name AS store_name, u.full_name AS buyer_name
             FROM orders o
             JOIN deliveries d ON o.id = d.order_id
             JOIN stores s ON o.store_id = s.id
             JOIN users u ON o.buyer_id = u.id
             WHERE o.status = 'Delivering' 
               AND d.delivery_person_id IS NULL 
               AND d.status = 'Requested'
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
router.put('/delivery/accept/:orderId', protectDeliveryPerson, async (req, res) => {
    const orderId = req.params.orderId;
    const entregadorId = req.user.id;

    if (req.user.is_available === 0) {
        return res.status(400).json({ success: false, message: 'Você já está com uma entrega pendente.' });
    }

    try {
        await pool.query('BEGIN');

        const [deliveryUpdate] = await pool.execute(
            `UPDATE deliveries SET delivery_person_id = ?, status = 'Accepted' 
             WHERE order_id = ? AND status = 'Requested' AND delivery_person_id IS NULL`,
            [entregadorId, orderId]
        );
        
        if (deliveryUpdate.affectedRows === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Pedido não disponível ou já aceito.' });
        }

        await pool.execute('UPDATE users SET is_available = FALSE WHERE id = ?', [entregadorId]);

        await pool.query('COMMIT');
        res.status(200).json({ success: true, message: 'Pedido aceito! Boa entrega.' });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/ACCEPT] Erro ao aceitar pedido:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao aceitar pedido.' });
    }
});


// ===================================================================
// ROTA DE CONFIRMAÇÃO E FLUXO FINANCEIRO
// ===================================================================

/**
 * Rota 6: Confirmação de Entrega (POST /api/delivery/confirm)
 * Confirma a entrega via código e atualiza o saldo (Lógica Financeira Corrigida).
 */
router.post('/delivery/confirm', protect, async (req, res) => {
    const userId = req.user.id; 
    const { order_id, confirmation_code } = req.body;

    try {
        await pool.query('BEGIN');
        
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

        const isDeliveryPerson = (order.delivery_person_id === userId);
        
        if (order.buyer_id !== userId && !isDeliveryPerson) {
             await pool.query('ROLLBACK');
             return res.status(403).json({ success: false, message: 'Apenas o comprador ou entregador atribuído pode confirmar.' });
        }
        
        let paymentMessage = 'Pagamento em processamento.';
        
        // Regras Financeiras:
        if (order.delivery_method === 'Seller' || order.delivery_method === 'Contracted') {
            const marketplaceFee = order.total_amount * MARKETPLACE_FEE_RATE;
            const sellerEarnings = order.total_amount - marketplaceFee; 
            
            await pool.execute(
                'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
                [sellerEarnings, order.seller_id]
            );
            paymentMessage = `Entrega confirmada. R$${sellerEarnings.toFixed(2)} creditados ao vendedor.`;
        }
        else if (order.delivery_method === 'Marketplace' && order.delivery_person_id) {
            const marketplaceFee = order.total_amount * MARKETPLACE_FEE_RATE;
            const deliveredPayment = DELIVERY_FEE; 
            const sellerEarnings = order.total_amount - marketplaceFee - deliveredPayment; 
            
            // 3.1. Credita no saldo do Entregador
            await pool.execute(
                'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
                [deliveredPayment, order.delivery_person_id]
            );
            
            // 3.2. Credita o lucro do Vendedor
             await pool.execute(
                'UPDATE users SET pending_balance = pending_balance + ? WHERE id = ?',
                [sellerEarnings, order.seller_id]
            );

            // 3.3. Marca o entregador como DISPONÍVEL
            await pool.execute('UPDATE users SET is_available = TRUE WHERE id = ?', [order.delivery_person_id]);
            
            paymentMessage = `Entrega Marketplace confirmada. R$${deliveredPayment.toFixed(2)} creditados ao entregador.`;
        }
        
        // 4. Atualiza status da entrega e do pedido para finalizado
        await pool.execute('UPDATE orders SET status = "Completed" WHERE id = ?', [order_id]);
        await pool.execute('UPDATE deliveries SET status = "Delivered_Confirmed", buyer_confirmation_at = NOW() WHERE order_id = ?', [order_id]);

        await pool.query('COMMIT');
        res.status(200).json({ success: true, message: `Entrega confirmada. ${paymentMessage}` });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/CONFIRM] Erro ao confirmar entrega:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao confirmar entrega.' });
    }
});


// ===================================================================
// ROTAS DE SIMULAÇÃO PIX E WEBHOOKS
// ===================================================================

/**
 * Rota 6.5: Simular Pagamento (POST /api/delivery/orders/:orderId/simulate-payment)
 */
router.post('/delivery/orders/:orderId/simulate-payment', protect, async (req, res) => {
    const orderId = req.params.orderId;
    const buyerId = req.user.id;

    try {
        const [orderRows] = await pool.execute(
            "SELECT payment_transaction_id, status FROM orders WHERE id = ? AND buyer_id = ?",
            [orderId, buyerId]
        );

        const order = orderRows[0];
        if (!order) { return res.status(404).json({ success: false, message: 'Pedido não encontrado ou não pertence a você.' }); }
        if (order.status !== 'Pending Payment') { return res.status(400).json({ success: false, message: 'Este pedido não está mais pendente de pagamento.' }); }
        if (!order.payment_transaction_id) { return res.status(400).json({ success: false, message: 'Pedido não possui ID de transação PIX para simular.' }); }

        const simulationResult = await simulatePixPayment(order.payment_transaction_id);

        if (simulationResult.success) {
            res.status(200).json({ 
                success: true, 
                message: 'Simulação enviada com sucesso. Aguardando confirmação do webhook...' 
            });
        } else {
            throw new Error('Falha no serviço de simulação.');
        }

    } catch (error) {
        console.error('[SIMULATE] Erro ao simular pagamento:', error.message);
        res.status(500).json({ success: false, message: error.message || 'Erro interno ao simular.' });
    }
});


/**
 * Rota 7: Webhook para notificações da AbacatePay
 */
router.post('/abacatepay/notifications', async (req, res) => {
    const notification = req.body;
    
    console.log('🔔 [WEBHOOK ABACATEPAY] Notificação Recebida:', JSON.stringify(notification, null, 2));

    try {
        if (notification.event === 'PAYMENT_APPROVED' && notification.data) {
            const transactionId = notification.data.id;
            const status = notification.data.status;

            if (status === 'APPROVED') {
                await pool.query('BEGIN');
                try {
                    // MUDANÇA DE STATUS: Pending Payment -> Processing
                    const [result] = await pool.execute(
                        "UPDATE orders SET status = 'Processing' WHERE payment_transaction_id = ? AND status = 'Pending Payment'",
                        [transactionId]
                    );

                    if (result.affectedRows > 0) {
                        console.log(`[WEBHOOK] Pedido (ID Transação: ${transactionId}) atualizado para 'Processing'.`);
                    } else {
                        console.warn(`[WEBHOOK] Pedido (ID Transação: ${transactionId}) não encontrado ou já processado.`);
                    }
                    await pool.query('COMMIT');
                } catch (error) {
                    await pool.query('ROLLBACK');
                    throw error; 
                }
            }
        }
        res.status(200).json({ success: true, message: 'Notificação recebida.' });
    } catch (error) {
        console.error('[WEBHOOK ABACATEPAY] Erro ao processar notificação:', error);
        res.status(200).json({ success: true, message: 'Notificação recebida (com erro interno).' });
    }
});


/**
 * Rota 8: Checar Status do Pedido (para Polling)
 */
router.get('/delivery/orders/:orderId/status', protect, async (req, res) => {
    const orderId = req.params.orderId;
    const buyerId = req.user.id;

    try {
        const [orderRows] = await pool.execute(
            "SELECT status, delivery_code FROM orders WHERE id = ? AND buyer_id = ?",
            [orderId, buyerId]
        );

        const order = orderRows[0];

        if (!order) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado ou não pertence a você.' });
        }

        res.status(200).json({ success: true, status: order.status, delivery_code: order.delivery_code });

    } catch (error) {
        console.error('[STATUS] Erro ao checar status do pedido:', error.message);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


module.exports = router;
