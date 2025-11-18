// ! Arquivo: brevoService.js
const SibApiV3Sdk = require('sib-api-v3-sdk');

// ! 1. Configuração da API Brevo (Sendinblue)
// Configura o client padrão
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];

// ! Obtém a chave API da Brevo a partir das variáveis de ambiente
// IMPORTANTE: Certifique-se de que process.env.BREVO_API_KEY esteja configurada no Render.
apiKey.apiKey = process.env.BREVO_API_KEY; 

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// ! 2. Variáveis de Ambiente para o Remetente
// Puxa o email de remetente configurado no Render.
const SENDER_EMAIL = process.env.EMAIL_REMETENTE_EMAIL || 'no-reply@marketplace.com';
const SENDER_NAME = "Suporte Marketplace"; 

/**
 * Envia um email transacional de boas-vindas usando a API da Brevo.
 * * @param {string} toEmail - O endereço de email do destinatário.
 * @param {string} toName - O nome do destinatário.
 * @returns {boolean} - Retorna true se o envio foi bem-sucedido, false caso contrário.
 */
const sendWelcomeEmail = async (toEmail, toName) => {
    // Cria o objeto de envio de email
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    
    // Configurações do email
    sendSmtpEmail.subject = "🥳 Bem-vindo(a) ao seu Marketplace!";
    sendSmtpEmail.htmlContent = `
        <html>
            <body>
                <h2>Olá ${toName},</h2>
                <p>Obrigado por se juntar à nossa comunidade! Seu cadastro foi concluído com sucesso.</p>
                <p>Seja bem-vindo(a) e boas compras/vendas!</p>
                <br>
                <p>Atenciosamente,</p>
                <p>${SENDER_NAME}</p>
            </body>
        </html>
    `;

    // Remetente (usando a variável de ambiente)
    sendSmtpEmail.sender = {
        "name": SENDER_NAME, 
        "email": SENDER_EMAIL
    };
    
    // Destinatário
    sendSmtpEmail.to = [
        {"email": toEmail, "name": toName}
    ];

    try {
        console.log(`Tentando enviar email de boas-vindas para: ${toEmail}`);
        // ! Chamada para a API da Brevo
        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('Email de boas-vindas enviado com sucesso. Resposta da Brevo:', data);
        return true;
    } catch (error) {
        // Trata e loga erros da API
        console.error('❌ ERRO ao enviar email Brevo:', error.response ? error.response.text : error.message);
        return false;
    }
};

module.exports = {
    sendWelcomeEmail
};
