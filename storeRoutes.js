// ! Arquivo: storeRoutes.js (CORRIGIDO: Endereço Segmentado e WhatsApp)
const express = require('express');
const router = express.Router();
const { protectSeller } = require('./sellerAuthMiddleware'); 
const pool = require('./config/db'); // Importa o pool central

// -------------------------------------------------------------------
// ROTAS PRIVADAS (para painel.html)
// -------------------------------------------------------------------

/**
 * 1. Rota para BUSCAR a loja do lojista logado (GET /api/stores/mine) - Com Endereço Segmentado
 */
router.get('/stores/mine', protectSeller, async (req, res) => {
    const seller_id = req.user.id;
    
    try {
        // Inclui LEFT JOIN para pegar os nomes de categoria, cidade e bairro
        const [rows] = await pool.execute(
            `SELECT s.*, 
                c.name AS category_name,
                city.name AS city_name,
                d.name AS district_name
             FROM stores s
             LEFT JOIN categories c ON s.category_id = c.id
             LEFT JOIN cities city ON s.city_id = city.id
             LEFT JOIN districts d ON s.district_id = d.id
             WHERE s.seller_id = ? LIMIT 1`,
            [seller_id]
        );

        const store = rows[0];

        if (!store) {
            return res.status(404).json({ success: false, message: 'Nenhuma loja encontrada para este lojista.' });
        }
        
        res.status(200).json({ success: true, store: store });

    } catch (error) {
        console.error('[STORES/MINE] ERRO FATAL ao buscar loja:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar dados da loja.' });
    }
});

/**
 * 2. Rota para CRIAR uma nova loja (POST /api/stores) - Com Endereço Segmentado
 */
router.post('/stores', protectSeller, async (req, res) => {
    const seller_id = req.user.id;
    const { 
        name, bio, logo_url, banner_url, category_id,
        city_id, district_id, address_street, address_number, 
        address_nearby, whatsapp_number 
    } = req.body; 

    // Validação de campos obrigatórios
    if (!name || !category_id || !city_id || !district_id || !address_street || !address_number || !whatsapp_number) {
        return res.status(400).json({ success: false, message: 'Nome, Categoria, Endereço Completo (Rua, Número, Cidade, Bairro) e WhatsApp são obrigatórios.' });
    }

    try {
        const [existingStore] = await pool.execute('SELECT id FROM stores WHERE seller_id = ?', [seller_id]);
        if (existingStore.length > 0) {
            return res.status(409).json({ success: false, message: 'Este vendedor já possui uma loja cadastrada.' });
        }

        const [result] = await pool.execute(
            `INSERT INTO stores 
                (seller_id, name, bio, logo_url, banner_url, category_id, 
                 city_id, district_id, address_street, address_number, address_nearby, whatsapp_number) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                seller_id, name, bio || null, logo_url || null, banner_url || null, category_id,
                city_id, district_id, address_street, address_number, 
                address_nearby || null, whatsapp_number
            ]
        );
        
        res.status(201).json({ success: true, message: 'Loja criada com sucesso. Bem-vindo!', store_id: result.insertId });

    } catch (error) {
        console.error('[STORES] ERRO ao criar loja:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao salvar loja.' });
    }
});

/**
 * 3. Rota para ATUALIZAR a loja (PUT /api/stores/:id) - Com Endereço Segmentado
 */
router.put('/stores/:id', protectSeller, async (req, res) => {
    const storeId = req.params.id;
    const seller_id = req.user.id;
    
    const { 
        name, bio, logo_url, banner_url, category_id,
        city_id, district_id, address_street, address_number, 
        address_nearby, whatsapp_number 
    } = req.body; 

    // Validação de campos obrigatórios
    if (!name || !category_id || !city_id || !district_id || !address_street || !address_number || !whatsapp_number) {
        return res.status(400).json({ success: false, message: 'Nome, Categoria, Endereço Completo (Rua, Número, Cidade, Bairro) e WhatsApp são obrigatórios.' });
    }

    try {
        const [result] = await pool.execute(
            `UPDATE stores SET 
                name = ?, bio = ?, logo_url = ?, banner_url = ?, category_id = ?, 
                city_id = ?, district_id = ?, address_street = ?, address_number = ?, 
                address_nearby = ?, whatsapp_number = ?
             WHERE id = ? AND seller_id = ?`,
            [
                name, bio || null, logo_url || null, banner_url || null, category_id,
                city_id, district_id, address_street, address_number, 
                address_nearby || null, whatsapp_number,
                storeId, seller_id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Loja não encontrada ou acesso negado.' });
        }

        res.status(200).json({ success: true, message: 'Loja atualizada com sucesso.' });

    } catch (error) {
        console.error('[STORES] Erro ao atualizar loja:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar loja.' });
    }
});


// -------------------------------------------------------------------
// ROTA PÚBLICA (para store_profile.html)
// -------------------------------------------------------------------
/**
 * 4. Rota para LER o perfil da loja (GET /api/stores/:id) - PÚBLICA (Com Endereço Segmentado)
 */
router.get('/stores/:id', async (req, res) => {
    const storeId = req.params.id;

    try {
        const [storeRows] = await pool.execute(
            `SELECT s.*, 
                c.name AS category_name,
                city.name AS city_name,
                d.name AS district_name
             FROM stores s
             LEFT JOIN categories c ON s.category_id = c.id
             LEFT JOIN cities city ON s.city_id = city.id
             LEFT JOIN districts d ON s.district_id = d.id
             WHERE s.id = ? LIMIT 1`,
            [storeId]
        );

        if (storeRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Loja não encontrada.' });
        }
        
        const store = storeRows[0];
        
        const [productRows] = await pool.execute(
            'SELECT id, name, description, price, image_url FROM products WHERE seller_id = ? AND is_active = TRUE ORDER BY created_at DESC',
            [store.seller_id]
        );

        res.status(200).json({ success: true, store: store, products: productRows });

    } catch (error) {
        console.error('[STORES/:ID] ERRO ao buscar loja:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar perfil da loja.' });
    }
});

module.exports = router;
