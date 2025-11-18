// ! Arquivo: deliveryAuthMiddleware.js (Middleware de Proteção do Entregador)
const jwt = require('jsonwebtoken');
const pool = require('./config/db'); 

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware para proteger rotas e garantir que APENAS ENTREGADORES tenham acesso.
 */
const protectDeliveryPerson = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            token = req.headers.authorization.split(' ')[1];
            
            // 1. Verificar e decodificar o token
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // 2. Buscar o perfil completo e o status (is_delivery_person)
            const [rows] = await pool.execute(
                'SELECT id, is_delivery_person, is_available, pending_balance FROM users WHERE id = ? LIMIT 1', 
                [decoded.id]
            );
            const user = rows[0];

            if (!user) {
                return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });
            }

            // 3. Verificar a permissão de entregador
            if (!user.is_delivery_person) {
                console.log(`[AUTH/DELIVERY] BLOQUEADO: Usuário ID ${user.id} não é um entregador.`);
                return res.status(403).json({ success: false, message: 'Acesso negado. Apenas entregadores podem acessar.' });
            }

            // 4. Se for entregador, prossegue
            req.user = user; 
            console.log(`[AUTH/DELIVERY] SUCESSO: Entregador ID ${user.id} autorizado.`);
            
            next();

        } catch (error) {
            console.error('[AUTH/DELIVERY] FALHA: Erro de token ou servidor.', error);
            res.status(401).json({ success: false, message: 'Não autorizado, token inválido ou erro de servidor.' });
        }
    }

    if (!token) {
        res.status(401).json({ success: false, message: 'Não autorizado, token ausente.' });
    }
};

module.exports = { protectDeliveryPerson };
