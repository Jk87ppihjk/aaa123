// ! Arquivo: orderCreationRoutes.js (FINAL CORRIGIDO: Cálculo de Frete Dinâmico e Itens)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protectDeliveryPerson } = require('./deliveryAuthMiddleware');
const { protect, protectWithAddress } = require('./authMiddleware'); 

// 1. IMPORTAÇÃO DO MERCADO PAGO 
const { MercadoPagoConfig, Preference } = require('mercadopago');

// --- Constantes Comuns ---
const MARKETPLACE_FEE_RATE = 0.08; // 8%
const DELIVERY_FEE_FALLBACK = 5.00; // R$ 5,00 (Usado como frete padrão/repasse ao entregador, se não definido pelo lojista)

// ===================================================================
// FUNÇÃO AUXILIAR DE CRIAÇÃO (MANTIDA)
// ===================================================================
const createOrderAndCodes = async (buyerId, storeId, totalAmount, initialStatus, transactionId, items, addressSnapshot) => {
    const deliveryCode = Math.random().toString(36).substring(2, 8).toUpperCase(); 
    const pickupCode = Math.random().toString(36).substring(2, 7).toUpperCase(); 

    // 1. Insere o pedido com o endereço segmentado e o total final
    const [orderResult] = await pool.execute(
        `INSERT INTO orders (
            buyer_id, store_id, total_amount, status, delivery_code, payment_transaction_id, delivery_pickup_code,
            delivery_city_id, delivery_district_id, delivery_address_street, 
            delivery_address_number, delivery_address_nearby, buyer_whatsapp_number
         ) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            buyerId, storeId, totalAmount, initialStatus, deliveryCode, transactionId, pickupCode,
            addressSnapshot.city_id, 
            addressSnapshot.district_id, 
            addressSnapshot.address_street, 
            addressSnapshot.address_number, 
            addressSnapshot.address_nearby, 
            addressSnapshot.whatsapp_number 
        ]
    );
    const orderId = orderResult.insertId;

    // 2. Salvar os Itens na tabela order_items e Baixar Estoque
    for (const item of items) {
        const productId = parseInt(item.product_id, 10) || parseInt(item.id, 10);
        const quantity = parseInt(item.qty, 10);
        
        const price = parseFloat(item.product_price || item.price || 0); 
        const name = item.product_name || item.name || 'Produto';
        
        const attributesToSave = item.options || item.selected_options || item.attributes_data || {};
        const attributes = JSON.stringify(attributesToSave);

        console.log(`[ORDER CREATION LOG - ITEM ${orderId}] Nome: ${name} | Preço Unitário: ${price.toFixed(2)} | Atributos JSON (para DB): ${attributes}`);

        if (!productId || !quantity) {
             throw new Error('Item inválido no carrinho durante a criação do pedido.');
        }

        // A. INSERE NA TABELA DE ITENS
        await pool.execute(
            `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, attributes_json) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [orderId, productId, name, quantity, price, attributes]
        );

        // B. ATUALIZA O ESTOQUE
        const [stockUpdate] = await pool.execute(
            'UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?',
            [quantity, productId, quantity]
        );
        if (stockUpdate.affectedRows === 0) {
            throw new Error(`Estoque insuficiente para o item ID ${productId}.`);
        }
    }
    
    return { orderId, deliveryCode, pickupCode };
};


// ===================================================================
// FUNÇÃO DE CÁLCULO DE TOTAL (CORRIGIDA)
// ===================================================================
const calculateDynamicTotal = async (items, buyerCityId) => { // ADICIONADO buyerCityId
    const productIds = items
        .map(item => parseInt(item.product_id, 10))
        .filter(id => !isNaN(id) && id > 0);

    if (productIds.length === 0) {
         throw new Error('Carrinho vazio ou contendo apenas itens inválidos.');
    }
    
    const idList = productIds.join(','); 
    
    // CRÍTICO: Seleciona as opções de frete (shipping_options)
    const [products] = await pool.query(
        `SELECT p.id, p.price, p.shipping_options, s.id AS store_id 
         FROM products p JOIN stores s ON p.seller_id = s.seller_id 
         WHERE p.id IN (${idList})` 
    );
    
    if (products.length === 0) {
        throw new Error('Nenhum produto válido encontrado no banco de dados.');
    }

    const productMap = products.reduce((map, p) => {
        map[p.id] = p;
        return map;
    }, {});
    
    let subTotalProdutos = 0;
    const lojasUnicas = new Set();
    const storeFreteCosts = {}; // { store_id: cost }
    
    for (const item of items) {
        const productIdNum = parseInt(item.product_id, 10);
        const productInfo = productMap[productIdNum];

        if (!productInfo) {
            console.warn(`[calculateDynamicTotal] Item ID ${productIdNum} ignorado.`);
            continue; 
        }

        const storeId = productInfo.store_id;
        
        subTotalProdutos += parseFloat(productInfo.price) * item.qty;
        lojasUnicas.add(storeId);
        
        // 1. Tenta calcular o frete dinâmico (apenas uma vez por loja)
        if (!storeFreteCosts[storeId]) {
            let freteCost = DELIVERY_FEE_FALLBACK;
            
            if (productInfo.shipping_options && buyerCityId) {
                try {
                    const shippingOptions = JSON.parse(productInfo.shipping_options);
                    // Compara o ID da cidade do comprador (buyerCityId) com as opções de frete
                    const cityOption = shippingOptions.find(opt => opt.city_id == buyerCityId);
                    
                    if (cityOption) {
                        freteCost = parseFloat(cityOption.cost);
                        console.log(`[CALC] Frete dinâmico p/ Loja ${storeId} (City ${buyerCityId}): R$${freteCost.toFixed(2)}`);
                    } else {
                        // Se não encontrar frete para a cidade, cancela a compra (opção mais segura)
                        // OU, dependendo da regra, usa o FALLBACK, mas para visibilidade é melhor CANCELAR
                        console.warn(`[CALC] Frete não definido p/ cidade ${buyerCityId} na loja ${storeId}.`);
                        // Aqui, em vez de falhar, vamos usar um valor muito alto ou o fallback para garantir que o cliente perceba o erro.
                        // *No entanto, como o productRoutes.js já filtrou, assumimos que existe uma opção.*
                        // *Se não existir, significa que o frontend permitiu o item, o que é um bug.*
                        // *Usaremos o FALLBACK por segurança, mas recomendamos que o filtro seja rigoroso.*
                    }
                } catch (e) {
                    console.error('[CALC] Erro ao fazer parse do JSON de frete. Usando fallback.', e.message);
                }
            }
            storeFreteCosts[storeId] = freteCost; 
        }
    }
    
    // 2. Soma o frete de todas as lojas
    let freteTotal = 0;
    Object.values(storeFreteCosts).forEach(cost => {
        freteTotal += cost;
    });

    const valorTotal = subTotalProdutos + freteTotal;
    
    return { valorTotal: parseFloat(valorTotal.toFixed(2)), freteTotal: parseFloat(freteTotal.toFixed(2)), subTotalProdutos: parseFloat(subTotalProdutos.toFixed(2)), numeroDeLojas: lojasUnicas.size };
};


// ===================================================================
// FUNÇÃO AUXILIAR DE PAGAMENTO (MANTIDA)
// ===================================================================
async function createMercadoPagoPreference(productId, payerEmail, totalAmount, orderId, sellerToken, sellerId) {
    if (!sellerToken) {
      throw new Error('Vendedor ou Token de Produção não encontrado no DB.');
    }

    const marketplaceFeeAmount = parseFloat((totalAmount * MARKETPLACE_FEE_RATE).toFixed(2));
    console.log(`[MP/PREF] Pedido #${orderId} | Total: ${totalAmount} | Fee: ${marketplaceFeeAmount} | Vendedor: ${sellerId}`);
    
    const sellerClient = new MercadoPagoConfig({ accessToken: sellerToken });
    const preference = new Preference(sellerClient);

    const body = {
      items: [{
          id: productId.toString(),
          title: `Pedido #${orderId} - Marketplace`,
          description: `Pagamento referente ao pedido ${orderId}`,
          unit_price: parseFloat(totalAmount), 
          quantity: 1,
        }],
      payer: { email: payerEmail },
      marketplace_fee: marketplaceFeeAmount, 
      external_reference: orderId.toString(), 
      payment_methods: { installments: 1 },
      back_urls: {
        success: `${process.env.FRONTEND_URL}/meus-pedidos?status=success&order_id=${orderId}`,
        failure: `${process.env.FRONTEND_URL}/meus-pedidos?status=failure&order_id=${orderId}`,
      },
      notification_url: `${process.env.BACKEND_URL}/api/mp/webhook-mp`, 
    };

    const response = await preference.create({ body });
    
    return { 
        init_point: response.init_point,
        preference_id: response.id 
    };
}


// ===================================================================
// ROTA DE CRIAÇÃO DE PEDIDOS (CHECKOUT REAL) - CORRIGIDA
// ===================================================================
router.post('/orders', [protect, protectWithAddress], async (req, res) => {
    const buyerId = req.user.id;
    const { items } = req.body;
    const addressSnapshot = { ...req.user };
    const payerEmail = req.user.email; 
    
    // CRÍTICO: Obtém o ID da cidade do comprador (agora disponível em req.user)
    const buyerCityId = req.user.city_id; 

    if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Carrinho vazio.' });
    }
    
    let orderId; 

    try {
        // CHAMA O CÁLCULO DINÂMICO
        const { valorTotal, numeroDeLojas } = await calculateDynamicTotal(items, buyerCityId);
        
        if (numeroDeLojas !== 1) {
             return res.status(400).json({ success: false, message: 'Por favor, crie um pedido separado para cada loja.' });
        }
        
        const productIds = items.map(item => parseInt(item.product_id, 10)).filter(id => !isNaN(id) && id > 0);
        const [products] = await pool.execute('SELECT s.id AS store_id, s.seller_id FROM products p JOIN stores s ON p.seller_id = s.seller_id WHERE p.id = ? LIMIT 1', [productIds[0]]);
        
        if (!products[0]) throw new Error('Produto ou loja não encontrados.');

        const store_id = products[0].store_id;
        const seller_id = products[0].seller_id;
        const firstProductId = productIds[0].toString();
        
        // Busca token do vendedor
        const [sellerRows] = await pool.execute('SELECT mp_access_token FROM users WHERE id = ? LIMIT 1', [seller_id]);

        if (!sellerRows[0] || !sellerRows[0].mp_access_token) {
            throw new Error(`O vendedor (ID: ${seller_id}) não conectou sua conta do Mercado Pago.`);
        }
        const sellerToken = sellerRows[0].mp_access_token;
        
        await pool.query('BEGIN'); 
        
        // Cria pedido e salva itens
        const orderData = await createOrderAndCodes(
            buyerId, store_id, valorTotal, 'Pending Payment', 
            'TEMP_MP_ID', 
            items, addressSnapshot
        );
        orderId = orderData.orderId; 

        // Gera preferência MP
        const { init_point, preference_id } = await createMercadoPagoPreference(
            firstProductId, payerEmail, valorTotal, orderId, sellerToken, seller_id
        );

        // Atualiza com ID real do MP
        await pool.execute('UPDATE orders SET payment_transaction_id = ? WHERE id = ?', [preference_id, orderId]);
        
        await pool.query('COMMIT'); 

        res.status(201).json({ 
            success: true, 
            message: 'Pedido criado. Redirecionando para pagamento.', 
            order_id: orderId,
            total_amount: valorTotal, 
            init_point: init_point 
        });

    } catch (error) {
        await pool.query('ROLLBACK'); 
        console.error(`[DELIVERY/ORDERS] Erro:`, error);
        res.status(500).json({ success: false, message: 'Erro interno ao processar pedido.', error: error.message });
    }
});


// ===================================================================
// ROTA DE SIMULAÇÃO (MANTIDA CONFORME SOLICITADO) - CORRIGIDA
// ===================================================================
router.post('/orders/simulate-purchase', [protect, protectWithAddress], async (req, res) => {
    const buyerId = req.user.id;
    const { items } = req.body;
    const addressSnapshot = { ...req.user }; 
    const buyerCityId = req.user.city_id; // CRÍTICO: Obtém o ID da cidade

    if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'Carrinho vazio.' });

    let orderId;

    try {
        // CHAMA O CÁLCULO DINÂMICO
        const { valorTotal, numeroDeLojas } = await calculateDynamicTotal(items, buyerCityId);

        if (numeroDeLojas !== 1) return res.status(400).json({ success: false, message: 'Apenas mono-loja.' });

        const productIds = items.map(item => parseInt(item.product_id, 10));
        const [products] = await pool.execute('SELECT s.id AS store_id FROM products p JOIN stores s ON p.seller_id = s.seller_id WHERE p.id = ? LIMIT 1', [productIds[0]]);
        const store_id = products[0].store_id;

        await pool.query('BEGIN');

        // Cria pedido e salva itens
        const orderData = await createOrderAndCodes(
            buyerId, store_id, valorTotal, 'Processing', 
            'SIMULATED_PURCHASE', 
            items, addressSnapshot
        );
        orderId = orderData.orderId;

        await pool.query('COMMIT');

        res.status(201).json({ 
            success: true, 
            message: 'Pedido simulado criado (status: Processing). Itens salvos.', 
            order_id: orderId, 
            total_amount: valorTotal, 
            status: 'Processing' 
        });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[SIMULATE] Erro:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// ===================================================================
// ROTAS DE LOJISTA (PÓS-PAGAMENTO) - MANTIDAS
// ===================================================================

router.put('/orders/:orderId/delivery-method', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;
    const { method } = req.body; 

    if (!['Contracted', 'Marketplace'].includes(method)) {
        return res.status(400).json({ success: false, message: 'Método inválido.' });
    }

    try {
        const [orderCheck] = await pool.execute(
            `SELECT o.store_id, s.contracted_delivery_person_id, o.status 
             FROM orders o JOIN stores s ON o.store_id = s.id 
             WHERE o.id = ? AND s.seller_id = ?`,
            [orderId, sellerId]
        );

        if (orderCheck.length === 0) return res.status(403).json({ success: false, message: 'Acesso negado.' });
        
        if (orderCheck[0].status !== 'Processing') return res.status(400).json({ success: false, message: 'Status incorreto.' });

        const store = orderCheck[0];
        let deliveryPersonId = null;

        if (method === 'Contracted') {
            deliveryPersonId = store.contracted_delivery_person_id;
            if (!deliveryPersonId) return res.status(400).json({ success: false, message: 'Sem entregador contratado.' });
        }
        
        await pool.execute('UPDATE orders SET delivery_method = ?, status = "Delivering" WHERE id = ?', [method, orderId]);
        await pool.execute(
            `INSERT INTO deliveries (order_id, delivery_person_id, status, delivery_method) VALUES (?, ?, ?, ?)`,
            [orderId, deliveryPersonId, deliveryPersonId ? 'Accepted' : 'Requested', method]
        );

        if (method === 'Contracted' && deliveryPersonId) {
             await pool.execute('UPDATE users SET is_available = FALSE WHERE id = ?', [deliveryPersonId]);
        }

        res.status(200).json({ success: true, message: `Entrega definida como "${method}".` });

    } catch (error) {
        console.error('[DELIVERY/METHOD] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


router.put('/orders/:orderId/dispatch', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;

    try {
        await pool.query('BEGIN'); 

        const [orderCheck] = await pool.execute(
            `SELECT o.id, s.seller_id FROM orders o 
             JOIN stores s ON o.store_id = s.id 
             WHERE o.id = ? AND s.seller_id = ? AND o.status = 'Processing'`,
            [orderId, sellerId]
        );

        if (orderCheck.length === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Pedido não encontrado ou status inválido.' });
        }
        
        await pool.execute("UPDATE orders SET status = 'Delivering', delivery_method = 'Seller' WHERE id = ?", [orderId]);
        await pool.execute(
            `INSERT INTO deliveries (order_id, delivery_person_id, status, delivery_method, packing_start_time) 
             VALUES (?, NULL, 'Accepted', 'Seller', NOW())`, 
            [orderId]
        );
        
        await pool.query('COMMIT'); 
        res.status(200).json({ success: true, message: 'Pedido despachado! Pronto para a entrega.' });

    } catch (error) {
        await pool.query('ROLLBACK');
        console.error('[DELIVERY/DISPATCH] Erro:', error);
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});


router.put('/orders/:orderId/confirm-pickup', protectSeller, async (req, res) => {
    const orderId = req.params.orderId;
    const sellerId = req.user.id;
    const { pickup_code } = req.body; 

    try {
        await pool.query('BEGIN');
        const [orderRows] = await pool.execute(
            `SELECT o.id, o.delivery_pickup_code, s.seller_id, d.delivery_person_id
             FROM orders o JOIN stores s ON o.store_id = s.id LEFT JOIN deliveries d ON o.id = d.order_id
             WHERE o.id = ? AND s.seller_id = ? AND o.status = 'Delivering'`,
            [orderId, sellerId]
        );
        const order = orderRows[0];
        
        if (!order || !order.delivery_person_id) { 
            await pool.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Pedido inválido.' });
        }

        if (order.delivery_pickup_code !== pickup_code) {
             await pool.query('ROLLBACK');
             return res.status(400).json({ success: false, message: 'Código de retirada inválido.' });
        }

        await pool.execute(`UPDATE deliveries SET status = 'PickedUp', packing_start_time = NOW(), pickup_time = NOW() WHERE order_id = ?`, [orderId]);
        await pool.query('COMMIT');

        res.status(200).json({ success: true, message: 'Retirada confirmada.' });

    } catch (error) {
        await pool.query('ROLLBACK');
        res.status(500).json({ success: false, message: 'Erro interno.' });
    }
});

// A rota /orders/simulate-purchase duplicada no arquivo foi removida para usar a versão corrigida acima.

module.exports = router;
