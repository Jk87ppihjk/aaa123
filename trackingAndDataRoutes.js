// ! Arquivo: trackingAndDataRoutes.js (FINAL CORRIGIDO)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protect } = require('./authMiddleware'); 
const { getBuyerTrackingMessage, getSellerMetrics } = require('./trackingService'); 

const MARKETPLACE_FEE_RATE = 0.10;

// ===================================================================
// ROTAS DE LISTAGEM DE PEDIDOS
// ===================================================================

/**
 * Rota 10: Listar Pedidos da Loja (CORRIGIDA - Com Endereço e Itens)
 */
router.get('/orders/store/:storeId', protectSeller, async (req, res) => {
    const storeId = req.params.storeId;
    const sellerId = req.user.id;

    const [storeCheck] = await pool.execute('SELECT seller_id FROM stores WHERE id = ? AND seller_id = ?', [storeId, sellerId]);
    if (storeCheck.length === 0) return res.status(403).json({ success: false, message: 'Acesso negado.' });

    try {
        // 1. Busca Pedidos com Endereço e Status de Entrega
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, o.delivery_code, 
                d.status AS delivery_status,
                u.full_name AS buyer_name,
                dp.full_name AS delivery_person_name,
                o.delivery_address_street,
                o.delivery_address_number,
                o.delivery_address_nearby,
                o.buyer_whatsapp_number
             FROM orders o
             JOIN users u ON o.buyer_id = u.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             LEFT JOIN users dp ON d.delivery_person_id = dp.id
             WHERE o.store_id = ?
             ORDER BY o.created_at DESC`,
            [storeId]
        );
        
        // 2. ! POPULATE: Busca os Itens de cada pedido
        for (const order of orders) {
            const [items] = await pool.execute(
                `SELECT product_name, quantity, attributes_json, price /* CRÍTICO: Seleciona attributes_json e price */
                 FROM order_items WHERE order_id = ?`, 
                [order.id]
            );
            order.items = items; // Anexa array de produtos ao objeto do pedido
        }

        res.status(200).json({ success: true, orders: orders });

    } catch (error) {
        console.error('[DELIVERY/STORE_ORDERS] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


router.get('/orders/mine', protect, async (req, res) => {
    const buyerId = req.user.id; 
    try {
        const [orders] = await pool.execute(
            `SELECT 
                o.id, o.total_amount, o.status, o.delivery_method, o.created_at, o.delivery_code, 
                s.name AS store_name,
                d.status AS delivery_status, d.packing_start_time, d.pickup_time,
                dp.full_name AS delivery_person_name
             FROM orders o
             JOIN stores s ON o.store_id = s.id
             LEFT JOIN deliveries d ON o.id = d.order_id
             LEFT JOIN users dp ON d.delivery_person_id = dp.id
             WHERE o.buyer_id = ?
             ORDER BY o.created_at DESC`,
            [buyerId]
        );
        
        for (const order of orders) {
            // Busca itens também para o comprador ver o que comprou
            const [items] = await pool.execute('SELECT product_name, quantity, attributes_json FROM order_items WHERE order_id = ?', [order.id]);
            order.items = items;
            order.tracking_message = getBuyerTrackingMessage(order, order);
        }

        res.status(200).json({ success: true, orders: orders });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


// ===================================================================
// ROTAS DE STATUS E MÉTRICAS
// ===================================================================

// Rota 8: Polling de Status
router.get('/orders/:orderId/status', protect, async (req, res) => {
    const [orderRows] = await pool.execute(
        `SELECT o.status, o.delivery_code, d.status as delivery_status 
         FROM orders o LEFT JOIN deliveries d ON o.id = d.order_id 
         WHERE o.id = ? AND o.buyer_id = ?`, 
        [req.params.orderId, req.user.id]
    );
    if(!orderRows[0]) return res.status(404).json({success:false});
    res.json({success:true, status: orderRows[0].status, delivery_code: orderRows[0].delivery_code});
});

// Rota 13: Métricas do Vendedor
router.get('/users/seller/metrics', protectSeller, async (req, res) => {
    const sellerId = req.user.id; 
    try {
        const [userRows] = await pool.execute("SELECT pending_balance FROM users WHERE id = ?", [sellerId]);
        const metrics = await getSellerMetrics(sellerId);
        res.status(200).json({
            success: true,
            balance: { pending_balance: userRows[0].pending_balance || 0 },
            financial_info: { marketplace_fee_rate: MARKETPLACE_FEE_RATE * 100, pricing_note: "Taxa 10% + R$5 (se marketplace)" },
            metrics: metrics
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro métricas.' });
    }
});

module.exports = router;
