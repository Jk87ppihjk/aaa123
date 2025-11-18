// ! Arquivo: authMiddleware.js (CORREÇÃO CRÍTICA)
const jwt = require('jsonwebtoken');
const pool = require('./config/db');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware Padrão 'protect'
 * ATUALIZADO: Agora busca os campos de endereço segmentado.
 */
const protect = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            token = req.headers.authorization.split(' ')[1];
            
            // 1. Verificar e decodificar o token
            const decoded = jwt.verify(token, JWT_SECRET);
            
            // ### CORREÇÃO CRÍTICA APLICADA AQUI ###
            // A query SELECT agora inclui as colunas de endereço que faltavam.
            const [rows] = await pool.execute(
                `SELECT 
                    id, full_name, email, 
                    is_seller, is_admin, is_delivery_person, 
                    is_available, pending_balance,
                    city_id, district_id, address_street, 
                    address_number, address_nearby, whatsapp_number
                FROM users WHERE id = ? LIMIT 1`, 
                [decoded.id]
            );
            // ### FIM DA CORREÇÃO ###
            
            const user = rows[0];

            if (!user) {
                console.log(`[AUTH/GERAL] ERRO: Usuário ID ${decoded.id} não encontrado no DB.`);
                return res.status(401).json({ success: false, message: 'Usuário não encontrado.' });
            }

            // 3. Anexa o usuário (AGORA COM O ENDEREÇO) ao request
            console.log(`[AUTH/GERAL] SUCESSO: Usuário ID ${user.id} autorizado.`);
            req.user = user; 
            
            next();

        } catch (error) {
            const errorMessage = error.message || 'Erro na verificação do token.';
            console.error(`[AUTH/GERAL] FALHA: ${errorMessage}. Detalhe do Erro:`, error);
            
            res.status(401).json({ success: false, message: 'Não autorizado, token inválido ou expirado.' });
        }
    }

    if (!token) {
        console.log('[AUTH/GERAL] BLOQUEADO: Token não fornecido.');
        res.status(401).json({ success: false, message: 'Não autorizado, token ausente.' });
    }
};


/**
 * Middleware 'protectWithAddress'
 * (Esta função agora funciona, pois 'protect' fornece os dados corretos)
 */
const protectWithAddress = (req, res, next) => {
    // 'protect' já foi executada e anexou 'req.user' (agora com o endereço)
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
    }

    // A checagem agora funciona, pois req.user (de 'protect') contém city_id, etc.
    if (req.user.is_seller === 0 && req.user.is_admin === 0 && req.user.is_delivery_person === 0) {
        
        const hasAddress = req.user.city_id && req.user.district_id && req.user.address_street && req.user.whatsapp_number;
        
        if (!hasAddress) {
            // Retorna o código de erro que o checkout.html agora espera
            return res.status(403).json({ 
                success: false, 
                message: 'É obrigatório completar o cadastro de endereço e WhatsApp.',
                code: 'ADDRESS_REQUIRED' 
            });
        }
    }
    
    // Se tiver endereço ou não for um usuário comum, prossegue
    next();
};


/* O restante do arquivo (protectSeller, protectAdmin, protectDeliveryPerson) 
   permanece o mesmo, pois todos dependem do 'protect' principal.
*/

// --- Middleware para Lojistas (Sellers) ---
const protectSeller = async (req, res, next) => {
    await protect(req, res, async () => {
        if (req.user && req.user.is_seller) {
            console.log(`[AUTH/SELLER] SUCESSO: Usuário ID ${req.user.id} autorizado para rota de lojista.`);
            next();
        } else {
            console.log(`[AUTH/SELLER] BLOQUEADO: Usuário ID ${req.user ? req.user.id : 'N/A'} não é um lojista.`);
            res.status(403).json({ success: false, message: 'Acesso negado. Rota apenas para lojistas.' });
        }
    });
};

// --- Middleware para Administradores (Admin) ---
const protectAdmin = async (req, res, next) => {
    await protect(req, res, async () => {
        if (req.user && req.user.is_admin) {
            console.log(`[AUTH/ADMIN] SUCESSO: Usuário ID ${req.user.id} autorizado para rota de admin.`);
            next();
        } else {
            console.log(`[AUTH/ADMIN] BLOQUEADO: Usuário ID ${req.user ? req.user.id : 'N/A'} não é um admin.`);
            res.status(403).json({ success: false, message: 'Acesso negado. Rota apenas para administradores.' });
        }
    });
};

// --- Middleware para Entregadores (Delivery) ---
const protectDeliveryPerson = async (req, res, next) => {
     await protect(req, res, async () => {
        if (req.user && req.user.is_delivery_person) {
            console.log(`[AUTH/DELIVERY] SUCESSO: Usuário ID ${req.user.id} autorizado para rota de entregador.`);
            next();
        } else {
            console.log(`[AUTH/DELIVERY] BLOQUEADO: Usuário ID ${req.user ? req.user.id : 'N/A'} não é um entregador.`);
            res.status(403).json({ success: false, message: 'Acesso negado. Rota apenas para entregadores.' });
        }
    });
};

module.exports = { 
    protect, 
    protectSeller, 
    protectAdmin, 
    protectDeliveryPerson,
    protectWithAddress 
};
