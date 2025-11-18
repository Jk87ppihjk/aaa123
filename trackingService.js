// ! Arquivo: trackingService.js (NOVO)

const pool = require('./config/db');

// ===================================================================
// FUNÇÕES AUXILIARES DE CÁLCULO
// ===================================================================

/**
 * Converte um intervalo de tempo em segundos para um formato legível (Hh Mm Ss).
 * @param {number} totalSeconds - O tempo total em segundos.
 * @returns {string} Tempo formatado.
 */
const formatTime = (totalSeconds) => {
    if (totalSeconds === null) return 'N/A';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = Math.floor(totalSeconds % 60);

    let parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
};

// ===================================================================
// FUNÇÕES PRINCIPAIS DE CÁLCULO DE MÉTRICAS
// ===================================================================

/**
 * Calcula as métricas de embalagem e desempenho para um Vendedor (Seller).
 * @param {number} sellerId - ID do Vendedor.
 * @returns {Promise<object>} Métricas de desempenho.
 */
const getSellerMetrics = async (sellerId) => {
    // 1. Métrica de Velocidade de Embalagem (Packing)
    // Tempo = packing_start_time - created_at (Tempo entre a criação do pedido e o início da embalagem)
    const [packingResults] = await pool.execute(`
        SELECT AVG(TIMESTAMPDIFF(SECOND, o.created_at, d.packing_start_time)) AS avg_packing_time
        FROM orders o
        JOIN stores s ON o.store_id = s.id
        JOIN deliveries d ON o.id = d.order_id
        WHERE s.seller_id = ? AND d.packing_start_time IS NOT NULL;
    `, [sellerId]);

    // 2. Métrica de Velocidade de Despacho Próprio (Self-Delivery)
    // Tempo = delivery_time - packing_start_time (Tempo total de entrega própria)
    const [selfDeliveryResults] = await pool.execute(`
        SELECT 
            AVG(TIMESTAMPDIFF(SECOND, d.packing_start_time, d.delivery_time)) AS avg_delivery_time,
            MIN(TIMESTAMPDIFF(SECOND, d.packing_start_time, d.delivery_time)) AS min_delivery_time,
            MAX(TIMESTAMPDIFF(SECOND, d.packing_start_time, d.delivery_time)) AS max_delivery_time
        FROM orders o
        JOIN stores s ON o.store_id = s.id
        JOIN deliveries d ON o.id = d.order_id
        WHERE s.seller_id = ? AND o.delivery_method = 'Seller' AND d.delivery_time IS NOT NULL;
    `, [sellerId]);

    const metrics = {
        avgPackingTime: formatTime(packingResults[0].avg_packing_time),
        
        // Métricas de Entrega Própria
        avgSelfDeliveryTime: formatTime(selfDeliveryResults[0].avg_delivery_time),
        minSelfDeliveryTime: formatTime(selfDeliveryResults[0].min_delivery_time),
        maxSelfDeliveryTime: formatTime(selfDeliveryResults[0].max_delivery_time),
    };

    return metrics;
};

/**
 * Calcula as métricas de desempenho para um Entregador.
 * @param {number} deliveryPersonId - ID do Entregador.
 * @returns {Promise<object>} Métricas de desempenho.
 */
const getDeliveryPersonMetrics = async (deliveryPersonId) => {
    // 1. Métrica de Velocidade de Entrega (Delivery Speed)
    // Tempo = delivery_time - pickup_time (Tempo desde a retirada até a entrega final)
    const [deliveryResults] = await pool.execute(`
        SELECT 
            AVG(TIMESTAMPDIFF(SECOND, d.pickup_time, d.delivery_time)) AS avg_delivery_time,
            MIN(TIMESTAMPDIFF(SECOND, d.pickup_time, d.delivery_time)) AS min_delivery_time,
            MAX(TIMESTAMPDIFF(SECOND, d.pickup_time, d.delivery_time)) AS max_delivery_time
        FROM deliveries d
        WHERE d.delivery_person_id = ? AND d.delivery_time IS NOT NULL;
    `, [deliveryPersonId]);

    // 2. Métrica de Velocidade de Retirada (Pickup Speed)
    // Tempo = pickup_time - packing_start_time (Tempo desde que o lojista embalou até o entregador retirar)
    const [pickupResults] = await pool.execute(`
        SELECT AVG(TIMESTAMPDIFF(SECOND, d.packing_start_time, d.pickup_time)) AS avg_pickup_time
        FROM deliveries d
        WHERE d.delivery_person_id = ? AND d.pickup_time IS NOT NULL AND d.packing_start_time IS NOT NULL;
    `, [deliveryPersonId]);

    const metrics = {
        avgDeliveryTime: formatTime(deliveryResults[0].avg_delivery_time),
        minDeliveryTime: formatTime(deliveryResults[0].min_delivery_time),
        maxDeliveryTime: formatTime(deliveryResults[0].max_delivery_time),
        avgPickupSpeed: formatTime(pickupResults[0].avg_pickup_time),
    };

    return metrics;
};

// ===================================================================
// FUNÇÃO DE RASTREAMENTO PARA COMPRADOR (Status em Texto)
// ===================================================================

/**
 * Gera a mensagem de status de rastreamento para o comprador.
 * @param {object} order - O registro do pedido (com status, delivery_method, etc.).
 * @param {object} delivery - O registro de entrega associado (com delivery_person_id).
 * @returns {string} Mensagem detalhada para o comprador.
 */
const getBuyerTrackingMessage = (order, delivery) => {
    let message = '';

    if (order.status === 'Pending Payment') {
        return 'Aguardando confirmação de pagamento.';
    }
    
    if (order.status === 'Completed') {
        return 'Pedido concluído! Recebimento confirmado.';
    }
    
    if (order.status === 'Processing') {
        // Vendedor está embalando
        if (order.delivery_method === 'Seller' || !delivery) {
             message = 'Seu pedido está sendo preparado pelo lojista (embalagem).';
        } else if (order.delivery_method === 'Contracted' || order.delivery_method === 'Marketplace') {
             message = 'Seu pagamento foi confirmado. O lojista está preparando o envio.';
        }
        return message;
    }

    if (order.status === 'Delivering') {
        const dpAssigned = delivery && delivery.delivery_person_id;

        // --- Fluxo Vendedor ---
        if (order.delivery_method === 'Seller') {
            return 'O lojista já despachou seu pedido (Entrega Própria). Aguarde a chegada.';
        }

        // --- Fluxo Entregador ---
        if (order.delivery_method === 'Marketplace' || order.delivery_method === 'Contracted') {
            
            // 1. Procurando Entregador
            if (!dpAssigned) {
                return 'Estamos buscando um entregador disponível. Agradecemos a paciência.';
            }

            // 2. Encontrado/Contratado, mas não Retirou
            if (dpAssigned && delivery.status === 'Accepted' && !delivery.pickup_time) {
                return 'Encontramos um entregador disponível! Ele está a caminho da loja para retirar seu pedido.';
            }

            // 3. Retirado
            if (dpAssigned && delivery.pickup_time) {
                return 'O entregador já retirou seu pedido na loja e está em rota de entrega!';
            }
        }
        
        return 'Seu pedido está em trânsito. Consulte o status detalhado.';
    }

    return 'Status desconhecido.';
};


module.exports = {
    getSellerMetrics,
    getDeliveryPersonMetrics,
    getBuyerTrackingMessage,
    formatTime,
};
