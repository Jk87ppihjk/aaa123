// ! Arquivo: adminAuthMiddleware.js (CORRIGIDO)
const jwt = require('jsonwebtoken');
// const mysql = require('mysql2/promise'); // <-- Removido

const JWT_SECRET = process.env.JWT_SECRET;

// ! Importa o pool compartilhado
const pool = require('./config/db'); // <-- CORREÇÃO: Importa o pool central

/*
// ! Configuração do Banco de Dados (REMOVIDA)
const dbConfig = { ... }; 
const pool = mysql.createPool(dbConfig);
*/

/**
 * Middleware para proteger rotas e garantir que APENAS ADMINISTRADORES (is_admin=TRUE) tenham acesso.
 */
const protectAdmin = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            token = req.headers.authorization.split(' ')[1];
            
            // 1. Verificar e decodificar o token
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // 2. Buscar o perfil completo (incluindo o flag is_admin) no DB
            const [rows] = await pool.execute(
                'SELECT * FROM users WHERE id = ? LIMIT 1', // (Usei SELECT *)
                [decoded.id]
            );
            const user = rows[0];

            if (!user) {
                return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });
            }

            // 3. Verificar a permissão de Administrador
            if (!user.is_admin) {
                return res.status(403).json({ success: false, message: 'Acesso negado. Apenas Administradores podem realizar esta ação.' });
            }

            // 4. Se for Admin, prossegue
            // ! CORREÇÃO DO MIDDLEWARE: Passa os dados frescos do DB (user)
            // req.user = decoded; // <-- Linha antiga
            req.user = user; // <-- CORRETO
            
            next();

        } catch (error) {
            console.error('[AUTH ADMIN] Falha na Autorização:', error.message);
            res.status(401).json({ success: false, message: 'Não autorizado, token inválido ou erro de servidor.' });
        }
    }

    if (!token) {
        res.status(401).json({ success: false, message: 'Não autorizado, token ausente.' });
    }
};

module.exports = { protectAdmin };
