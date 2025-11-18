// ! Arquivo: mercadoPagoRoutes.js (CORREÇÃO DE VÍNCULO DO PEDIDO)
// Contém as rotas de OAuth (Conexão do Vendedor) e o Webhook de Pagamento.

const express = require('express');
const router = express.Router();
const https = require('https'); 
const { MercadoPagoConfig, Payment } = require('mercadopago');

// Importa o pool de conexão principal do PRP
const pool = require('./config/db'); 

// URL de Redirecionamento do OAuth (deve ser a URL deste backend + /api/mp/mp-callback)
const redirectUri = `${process.env.BACKEND_URL}/api/mp/mp-callback`;

// -----------------------------------------------------------------
// ROTA 1: Iniciar Conexão (OAuth) - /api/mp/conectar-vendedor
// -----------------------------------------------------------------
router.get('/conectar-vendedor', async (req, res) => {
  try {
    const internalSellerId = req.query.seller_id; 
    
    if (!internalSellerId) {
        return res.status(400).send('Erro: O seller_id (do app principal) é obrigatório.');
    }

    // Garante que o vendedor existe na tabela users
    await pool.execute('SELECT id FROM users WHERE id = ?', [internalSellerId]);

    const authUrl = 'https://auth.mercadopago.com/authorization?' +
        `client_id=${process.env.MP_MARKETPLACE_APP_ID}` +
        `&response_type=code` +
        `&platform_id=mp` +
        `&state=${internalSellerId}` + // Passa o ID do user do PRP
        `&redirect_uri=${redirectUri}`;
    
    res.redirect(authUrl); 
    
  } catch (error) {
    console.error('Erro ao gerar URL de autorização:', error); 
    res.status(500).send('Erro ao conectar com Mercado Pago.');
  }
});

// -----------------------------------------------------------------
// ROTA 2: Callback e Troca de Token (OAuth) - /api/mp/mp-callback
// -----------------------------------------------------------------
router.get('/mp-callback', async (req, res) => {
  try {
    const { code, state: sellerId } = req.query; // sellerId é o ID da tabela 'users'

    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/painel-vendedor?status=cancelado`);
    }

    // Lógica para trocar o código por um token
    const tokenResponse = await new Promise((resolve, reject) => {
        const data = JSON.stringify({
            client_id: process.env.MP_MARKETPLACE_APP_ID, client_secret: process.env.MP_MARKETPLACE_SECRET_KEY,
            code: code, redirect_uri: redirectUri, grant_type: 'authorization_code'
        });

        const reqOptions = {
            hostname: 'api.mercadopago.com', path: '/oauth/token', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
        };

        const clientReq = https.request(reqOptions, (clientRes) => {
            let responseData = ''; clientRes.on('data', (chunk) => { responseData += chunk; });
            clientRes.on('end', () => {
                try {
                    const jsonResponse = JSON.parse(responseData);
                    if (clientRes.statusCode !== 200) return reject(new Error(jsonResponse.message));
                    resolve(jsonResponse);
                } catch (e) { reject(new Error('Erro ao analisar resposta JSON do MP.')); }
            });
        });
        clientReq.on('error', (e) => { reject(e); });
        clientReq.write(data); clientReq.end();
    });

    const accessToken = tokenResponse.access_token;
    const refreshToken = tokenResponse.refresh_token;

    // ATUALIZAÇÃO: Salva os tokens na tabela 'users' do PRP
    if (sellerId && accessToken) { 
        await pool.execute(
            `UPDATE users SET 
             mp_access_token = ?, 
             mp_refresh_token = ?
             WHERE id = ?`,
            [accessToken, refreshToken, sellerId]
        );
        console.log(`[MP/OAuth] Token salvo para o Vendedor ID: ${sellerId}`);
    } 
    
    res.redirect(`${process.env.FRONTEND_URL}/painel-vendedor?status=sucesso`);

  } catch (error) {
    console.error('Erro ao obter/salvar credenciais no /mp-callback:', error.message);
    res.status(500).send('Erro ao processar autorização.');
  }
});


// -----------------------------------------------------------------
// ROTA 3: WEBHOOK / NOTIFICAÇÃO DE PAGAMENTO (IPN)
// (Unificada - Recebe do MP e atualiza o DB local)
// -----------------------------------------------------------------
router.post('/webhook-mp', async (req, res) => {
    const topic = req.query.topic || req.body.topic;
    const notificationId = req.query.id || req.body.data?.id; 

    if (topic !== 'payment' || !notificationId) {
        return res.status(200).send('Notificação ignorada (Não é "payment" ou falta ID).'); 
    }

    const mpAccessToken = process.env.MP_MARKETPLACE_SECRET_KEY;

    if (!mpAccessToken) {
        console.error('ERRO FATAL NO WEBHOOK: MP_MARKETPLACE_SECRET_KEY ausente ou não lida.');
        return res.status(400).send('Erro de configuração do servidor.'); 
    }

    try {
        // 1. Configura o client do MP (necessário para buscar o pagamento)
        const marketplaceClient = new MercadoPagoConfig({
          accessToken: mpAccessToken,
        });
        const paymentClient = new Payment(marketplaceClient);
        
        // 2. Busca a informação do pagamento
        const paymentInfo = await paymentClient.get({ id: notificationId });
        console.log(`--- WEBHOOK MP RECEBIDO --- Status: ${paymentInfo.status}, ID: ${notificationId}`);
        
        if (paymentInfo.status === 'approved') {
            console.log('--- PAGAMENTO MP APROVADO! ---');
            
            // ! CORREÇÃO: Usamos o external_reference (que é o OrderID que você enviou)
            const orderIdFromMP = paymentInfo.external_reference; 
            
            if (orderIdFromMP) {
                // Converte para um inteiro para uso no DB
                const internalOrderId = parseInt(orderIdFromMP, 10);
                
                // 3. LÓGICA UNIFICADA: Atualiza o pedido DIRETAMENTE no DB do PRP
                await pool.query('BEGIN');
                
                // Atualiza o status do pedido usando o Order ID (internalOrderId)
                const [result] = await pool.execute(
                    "UPDATE orders SET status = 'Processing' WHERE id = ? AND status = 'Pending Payment'",
                    [internalOrderId]
                );
                
                if (result.affectedRows > 0) {
                    console.log(`[WEBHOOK/MP] SUCESSO: Pedido (Order ID: ${internalOrderId}) atualizado para 'Processing'.`);
                } else {
                    console.warn(`[WEBHOOK/MP] AVISO: Pedido (Order ID: ${internalOrderId}) não encontrado ou já processado.`);
                }
                
                await pool.query('COMMIT');
            } else {
                 console.warn(`[WEBHOOK/MP] Pagamento ${notificationId} aprovado, mas sem referência externa (Order ID).`);
            }
        } 

    } catch (error) {
        await pool.query('ROLLBACK');
        const errorDetail = error.response ? error.response.data : error.message;
        console.error('ERRO NO PROCESSAMENTO DO WEBHOOK UNIFICADO:', errorDetail);
        
        // Retorna 500 para que o Mercado Pago tente reenviar o webhook
        return res.status(500).send('Erro no servidor ao processar notificação.'); 
    }

    res.status(200).send('Webhook processado.');
});


module.exports = router;
