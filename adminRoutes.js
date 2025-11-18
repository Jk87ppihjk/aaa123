// ! Arquivo: adminRoutes.js (CORRIGIDO E COMPLETO)
// Gerencia rotas de Admin e Utilitários (Cidades, Categorias, Atributos)

const express = require('express');
const router = express.Router();
const pool = require('./config/db'); // Pool de conexão compartilhado
const { protectAdmin } = require('./adminAuthMiddleware'); // Middleware de proteção Admin

// ==================================================================
// 1. ROTAS ADMINISTRATIVAS (Protegidas por protectAdmin)
// ==================================================================

/**
 * Rota GET /api/admin/stats
 * Retorna estatísticas para o Dashboard do Admin
 */
router.get('/admin/stats', protectAdmin, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [stores] = await pool.query('SELECT COUNT(*) as count FROM stores');
        const [orders] = await pool.query('SELECT COUNT(*) as count FROM orders');
        
        res.status(200).json({
            success: true,
            stats: {
                users: users[0].count,
                stores: stores[0].count,
                orders: orders[0].count
            }
        });
    } catch (error) {
        console.error('[ADMIN] Erro ao buscar estatísticas:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar estatísticas.' });
    }
});

// ==================================================================
// 2. ROTAS DE SISTEMA / UTILITÁRIOS (Usadas pelos formulários)
// ==================================================================

/**
 * Rota GET /api/cities
 * Lista todas as cidades (Necessário para o cadastro de endereço/frete)
 */
router.get('/cities', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM cities ORDER BY name ASC');
        res.status(200).json({ success: true, data: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar cidades:', error);
        res.status(500).json({ success: false, message: 'Erro ao carregar cidades.' });
    }
});

/**
 * Rota GET /api/categories
 * Lista todas as categorias principais (Necessário para criar loja)
 */
router.get('/categories', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM categories ORDER BY name ASC');
        res.status(200).json({ success: true, categories: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar categorias:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar categorias.' });
    }
});

/**
 * Rota GET /api/subcategories/:categoryId
 * Lista subcategorias de uma categoria (Necessário para criar produtos)
 */
router.get('/subcategories/:categoryId', async (req, res) => {
    const { categoryId } = req.params;
    try {
        const [rows] = await pool.query('SELECT * FROM subcategories WHERE category_id = ? ORDER BY name ASC', [categoryId]);
        res.status(200).json({ success: true, subcategories: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar subcategorias:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar subcategorias.' });
    }
});

/**
 * Rota GET /api/attributes/:subcategoryId
 * Lista atributos específicos da subcategoria (Necessário para formulário dinâmico)
 */
router.get('/attributes/:subcategoryId', async (req, res) => {
    const { subcategoryId } = req.params;
    try {
        const [rows] = await pool.query('SELECT * FROM attributes WHERE subcategory_id = ?', [subcategoryId]);
        res.status(200).json({ success: true, attributes: rows });
    } catch (error) {
        console.error('[SYSTEM] Erro ao buscar atributos:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar atributos.' });
    }
});

module.exports = router;
