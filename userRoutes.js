// ! Arquivo: userRoutes.js (Rotas para o Comprador/Usuário - COM LOGS)

const express = require('express');
const router = express.Router();
const pool = require('./config/db');
const { protect } = require('./authMiddleware'); // Importa o 'protect' JÁ CORRIGIDO

/**
 * Rota GET /api/user/me
 * (Usada pelo checkout.html)
 */
router.get('/user/me', protect, async (req, res) => {
    
    // LOG: Mostra os dados que o 'protect' (corrigido) forneceu.
    console.log(`[USER/ME - GET] Rota acessada. Retornando dados do req.user (fornecido pelo protect):`, JSON.stringify(req.user, null, 2));
    
    if (!req.user) {
        console.log("[USER/ME - GET] ERRO: req.user não foi encontrado, mesmo após o 'protect'.");
        return res.status(404).json({ success: false, message: 'Usuário não encontrado na sessão.' });
    }
    
    res.status(200).json({ success: true, user: req.user });
});

/**
 * Rota PUT /api/user/address
 * (Usada pelo address_setup.html)
 */
router.put('/user/address', protect, async (req, res) => {
    const userId = req.user.id; 
    
    const { 
        city_id, 
        district_id, 
        address_street, 
        address_number, 
        address_nearby, 
        whatsapp_number 
    } = req.body;

    // LOG: Mostra exatamente o que o frontend (address_setup.html) enviou.
    console.log(`[USER/ADDRESS - PUT] Usuário ${userId} está salvando o endereço. PAYLOAD RECEBIDO:`, JSON.stringify(req.body, null, 2));

    if (!city_id || !district_id || !address_street || !address_number || !whatsapp_number) {
        console.log("[USER/ADDRESS - PUT] ERRO: Validação falhou. Campos obrigatórios ausentes.");
        return res.status(400).json({ success: false, message: 'Todos os campos de endereço, exceto "Próximo a", e o WhatsApp são obrigatórios.' });
    }

    try {
        const [result] = await pool.execute(
            `UPDATE users SET 
                city_id = ?, 
                district_id = ?, 
                address_street = ?, 
                address_number = ?, 
                address_nearby = ?, 
                whatsapp_number = ?
             WHERE id = ?`,
            [
                city_id, 
                district_id, 
                address_street, 
                address_number, 
                address_nearby || null, // Permite null se vazio
                whatsapp_number,
                userId
            ]
        );

        // LOG: Confirma que o banco de dados foi realmente alterado.
        console.log(`[USER/ADDRESS - PUT] SUCESSO: Banco de dados atualizado. ${result.affectedRows} linha(s) afetada(s).`);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        res.status(200).json({ success: true, message: 'Endereço e WhatsApp atualizados com sucesso.' });

    } catch (error) {
        console.error('[USER/ADDRESS - PUT] ERRO FATAL no DB:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao salvar endereço.' });
    }
});

module.exports = router;
