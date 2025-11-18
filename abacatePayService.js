// ! Arquivo: abacatePayService.js (Atualizado com simulação)
const axios = require('axios'); 

// ! ==================================================================
// ! ATENÇÃO: Verifique se esta é a URL correta do Sandbox (Modo Teste)
// ! ==================================================================
const ABACATEPAY_API_URL = 'https://api.abacatepay.com/v1/pixQrCode/create';
// ! NOVA URL DE SIMULAÇÃO (Verifique se é a URL de Sandbox correta)
const ABACATEPAY_SIMULATE_URL = 'https://api.abacatepay.com/v1/pixQrCode/simulate-payment'; 
// ! ==================================================================

const ABACATEPAY_SECRET = process.env.ABACATEPAY_SECRET; // Use sua CHAVE DE TESTE aqui no Render

/**
 * Cria um QRCode PIX através da API da AbacatePay.
 * (O restante desta função permanece o mesmo)
 */
const createPixQrCode = async (amount, expiresIn, description, customer = null) => {
    if (!ABACATEPAY_SECRET) {
        throw new Error('Serviço de pagamento indisponível: ABACATEPAY_SECRET ausente.');
    }
    // ... (validação do cliente) ...

    try {
        const requestBody = {
            amount: amount,
            expiresIn: expiresIn,
            description: description
        };
        if (customer) {
            requestBody.customer = customer;
        }

        const response = await axios.post(
            ABACATEPAY_API_URL, // URL de Criação
            requestBody,
            {
                headers: {
                    'Authorization': `Bearer ${ABACATEPAY_SECRET}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.status === 200 && response.data.data) {
            return {
                success: true,
                qrCodeData: response.data.data 
            };
        } else {
            throw new Error(response.data.error || 'Falha ao criar QRCode PIX.');
        }

    } catch (error) {
        const errorDetail = error.response ? error.response.data.error : error.message;
        console.error('❌ ERRO FATAL ao comunicar com AbacatePay (create):', errorDetail);
        throw new Error(`Falha ao criar QRCode PIX: ${errorDetail}`);
    }
};


// ! ==================================================================
// ! NOVA FUNÇÃO ADICIONADA (Para simular o pagamento)
// ! ==================================================================
/**
 * Simula o pagamento de um PIX no ambiente de Sandbox da AbacatePay.
 * @param {string} transactionId - O ID da transação (retornado por createPixQrCode).
 * @returns {Promise<object>} - Objeto com o sucesso da simulação.
 */
const simulatePixPayment = async (transactionId) => {
    if (!ABACATEPAY_SECRET) {
        throw new Error('Serviço de pagamento indisponível: ABACATEPAY_SECRET ausente.');
    }

    try {
        const response = await axios.post(
            ABACATEPAY_SIMULATE_URL, // ! URL de Simulação
            { id: transactionId },   // ! Corpo da requisição com o ID
            {
                headers: {
                    'Authorization': `Bearer ${ABACATEPAY_SECRET}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.status === 200) {
            console.log(`[ABACATEPAY/SIMULATE] Simulação para TxID ${transactionId} enviada com sucesso.`);
            return { success: true, data: response.data };
        } else {
            throw new Error(response.data.error || 'Falha ao simular pagamento.');
        }

    } catch (error) {
        const errorDetail = error.response ? error.response.data.error : error.message;
        console.error('❌ ERRO FATAL ao comunicar com AbacatePay (simulate):', errorDetail);
        throw new Error(`Falha ao simular pagamento: ${errorDetail}`);
    }
};


module.exports = {
    createPixQrCode,
    simulatePixPayment // ! Exporta a nova função
};
