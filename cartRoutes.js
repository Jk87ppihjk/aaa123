// ! Arquivo: cartRoutes.js (CORRIGIDO: Cálculo de Frete Dinâmico por Cidade)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protect } = require('./authMiddleware');

const DELIVERY_FEE = 5.00; // Valor de Frete Padrão (Usado como fallback)

// ******************************************************************
// NOVO: Função de Cálculo com Frete Dinâmico
// ******************************************************************
const calculateCartBreakdown = async (items, buyerCityId) => { // ADICIONADO buyerCityId
    
    console.log('[CART/CALC] Iniciando cálculo. Buyer City ID:', buyerCityId);

    const productIds = items
        .map(item => parseInt(item.product_id, 10)) 
        .filter(id => !isNaN(id) && id > 0);
    
    if (productIds.length === 0) {
        return {
            success: true,
            valorTotal: 0,
            freteTotal: 0,
            subTotalGeral: 0,
            numeroDeLojas: 0,
            cartBreakdown: [],
        };
    }

    const idList = productIds.join(','); 
    
    // ******************************************************************
    // 1. Query para buscar produtos, dados da loja E OPÇÕES DE FRETE
    // ******************************************************************
    const [products] = await pool.query(
        `SELECT p.id, p.name, p.price, p.image_url, p.shipping_options, -- ADICIONADO shipping_options
         s.id AS store_id, s.name AS store_name 
         FROM products p JOIN stores s ON p.seller_id = s.seller_id 
         WHERE p.id IN (${idList})` 
    );
    
    if (products.length === 0) {
        throw new Error("Nenhum produto encontrado no carrinho.");
    }

    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });

    const cartByStore = {};
    const lojasUnicas = new Set();
    
    let subTotalGeral = 0;
    
    // ******************************************************************
    // 3. Processar Itens e Agrupar por Loja (Cálculo de Frete Dinâmico)
    // ******************************************************************
    for (const item of items) {
        const productId = item.product_id;
        const quantity = item.qty;
        const options = item.options;

        const productInfo = productMap[productId];
        if (!productInfo) {
            console.warn(`[CART/CALC] Produto ID ${productId} não encontrado ou inativo. Pulando.`);
            continue;
        }

        const itemPrice = parseFloat(productInfo.price);
        const itemTotal = itemPrice * quantity;

        const storeId = productInfo.store_id;
        const storeName = productInfo.store_name;
        
        // -----------------------------------------------------------
        // INICIALIZAÇÃO DA LOJA E CÁLCULO DINÂMICO DO FRETE
        // -----------------------------------------------------------
        if (!cartByStore[storeId]) {
            let freteCost = DELIVERY_FEE; // Valor default/fallback
            
            // Tenta calcular o frete dinâmico
            if (productInfo.shipping_options && buyerCityId) {
                try {
                    // productInfo.shipping_options é uma string JSON, precisa de parse
                    const shippingOptions = JSON.parse(productInfo.shipping_options);
                    
                    // Encontra a opção de frete para a cidade do comprador
                    // Note: city_id é comparado como string para compatibilidade com JSON
                    const cityOption = shippingOptions.find(opt => opt.city_id == buyerCityId);
                    
                    if (cityOption) {
                        freteCost = parseFloat(cityOption.cost);
                        console.log(`[CART/CALC] Frete dinâmico p/ Loja ${storeId} (City ${buyerCityId}): R$${freteCost.toFixed(2)}`);
                    } else {
                        // Se não encontrou a cidade, usa o fallback (DELIVERY_FEE)
                        console.log(`[CART/CALC] Cidade do comprador (${buyerCityId}) sem opção de frete definida para a loja ${storeId}. Usando fallback: R$${DELIVERY_FEE.toFixed(2)}`);
                    }
                } catch (e) {
                    console.error('[CART/CALC] Erro ao fazer parse/cálculo do JSON de frete:', e.message);
                    // Em caso de erro de JSON, usa o valor default
                    freteCost = DELIVERY_FEE; 
                }
            } else if (productInfo.shipping_options && !buyerCityId) {
                 // Caso o produto exija frete, mas o usuário não esteja logado/sem cidade
                 console.warn('[CART/CALC] Produto com opções de frete, mas City ID do comprador não fornecido. Usando fallback.');
                 freteCost = DELIVERY_FEE;
            }

            cartByStore[storeId] = {
                store_id: storeId,
                store_name: storeName,
                items: [],
                subtotal_products: 0,
                frete_cost: freteCost, // Frete Dinâmico/Default
                total_with_shipping: 0,
            };
            lojasUnicas.add(storeId);
        }
        // -----------------------------------------------------------


        // Agrupa e atualiza subtotais
        cartByStore[storeId].items.push({
            product_id: productId,
            product_name: productInfo.name,
            image_url: productInfo.image_url,
            quantity: quantity,
            unit_price: itemPrice,
            total_item_price: itemTotal,
            selected_options: options, // Retorna as opções selecionadas
        });
        
        cartByStore[storeId].subtotal_products += itemTotal;
        subTotalGeral += itemTotal;
    }
    
    const numeroDeLojas = lojasUnicas.size;
    
    // 4. Totalização Final (Soma os custos de frete já definidos para cada loja)
    let freteTotal = 0;
    Object.values(cartByStore).forEach(store => {
        // Frete por loja (já calculado dinamicamente ou como fallback)
        freteTotal += store.frete_cost; 
        store.total_with_shipping = store.subtotal_products + store.frete_cost;
    });

    const valorTotalFinal = subTotalGeral + freteTotal;

    const finalResult = {
        success: true,
        valorTotal: parseFloat(valorTotalFinal.toFixed(2)),
        freteTotal: parseFloat(freteTotal.toFixed(2)),
        subTotalGeral: parseFloat(subTotalGeral.toFixed(2)),
        numeroDeLojas,
        cartBreakdown: Object.values(cartByStore),
    };

    console.log('[CART/CALC] Cálculo concluído com sucesso.');
    return finalResult;
};


router.post('/calculate', protect, async (req, res) => {
    console.log(`[CART/POST] Rota /api/cart/calculate acionada por utilizador ID: ${req.user.id}`);
    
    // CRÍTICO: Obtém o city_id do usuário logado
    const buyerCityId = req.user.city_id; 
    const { items } = req.body; 

    if (!items || !Array.isArray(items) || items.length === 0) {
        console.log('[CART/POST] Pedido com carrinho vazio. Retornando 0.');
        return res.status(200).json({ 
            success: true, 
            valorTotal: 0, 
            freteTotal: 0, 
            subTotalGeral: 0, 
            numeroDeLojas: 0, 
            cartBreakdown: [] 
        });
    }

    try {
        // PASSA O city_id para o cálculo
        const result = await calculateCartBreakdown(items, buyerCityId);
        res.status(200).json(result);
        
    } catch (error) {
        console.error('[CART/POST] ERRO CRÍTICO ao calcular carrinho:', error.message);
        console.error(error); 
        
        res.status(500).json({ 
            success: false, 
            message: 'Erro interno ao processar o carrinho. Detalhes: ' + error.message,
            // Adiciona info de debug para o frontend
            error: error.message 
        });
    }
});


module.exports = router;
