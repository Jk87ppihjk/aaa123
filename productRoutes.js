// ! Arquivo: productRoutes.js (CORRIGIDO: Suporte a Múltiplas Imagens + FILTRO DE CIDADE)
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken'); // NOVO: Necessário para checar o token na rota pública
const { protectSeller } = require('./sellerAuthMiddleware'); 
const { protect } = require('./authMiddleware'); 
const pool = require('./config/db'); // Importa o pool compartilhado

// --- Constantes de Preço ---
const MARKETPLACE_FEE = 0.00; 
const DELIVERY_FEE = 0.00;     
const TOTAL_ADDITION = MARKETPLACE_FEE + DELIVERY_FEE; 
const JWT_SECRET = process.env.JWT_SECRET; // Necessário para decodificar o token na rota pública

// -------------------------------------------------------------------
// Rotas de Produtos
// -------------------------------------------------------------------

// Função auxiliar para processar URLs de mídia
const processMediaUrls = (imageUrls, videoId) => {
    // O primeiro URL é a imagem principal
    const primaryImageUrl = (imageUrls && imageUrls.length > 0) ? imageUrls[0] : null;
    // O restante é a lista de detalhes (serializada como JSON)
    const detailImageUrlsJson = (imageUrls && imageUrls.length > 1) ? JSON.stringify(imageUrls.slice(1)) : null;
    
    const fyVideoId = videoId || null; 
    
    return { primaryImageUrl, detailImageUrlsJson, fyVideoId };
};

// Função auxiliar para tratar a resposta do banco de dados (parse JSON)
const parseProductDetails = (product) => {
    // Trata Imagens de Detalhe
    if (product.detail_image_urls) {
         try {
             product.detail_image_urls = JSON.parse(product.detail_image_urls);
         } catch(e) {
             console.error("Erro ao fazer parse de detail_image_urls:", e);
             product.detail_image_urls = [];
         }
    } else {
         product.detail_image_urls = [];
    }
    
    // NOVO: Trata Opções de Frete
    if (product.shipping_options) {
         try {
             // O campo pode ser retornado como string JSON ou como objeto, dependendo da versão do MySQL/query
             product.shipping_options = JSON.parse(product.shipping_options);
         } catch(e) {
             console.error("Erro ao fazer parse de shipping_options:", e);
             product.shipping_options = [];
         }
    } else {
         product.shipping_options = [];
    }
    
    return product;
}


// 1. Rota para CRIAR um novo produto (PROTEGIDA)
router.post('/products', protectSeller, async (req, res) => {
    const seller_id = req.user.id; 
    
    try {
        const [storeCheck] = await pool.execute('SELECT id FROM stores WHERE seller_id = ?', [seller_id]);
        
        if (storeCheck.length === 0) {
            return res.status(403).json({ success: false, message: 'A criação de produtos requer que sua loja esteja cadastrada primeiro.' });
        }
        
        // Desestruturação dos dados (INCLUSÃO DE shipping_options)
        const { 
            name, description, price, stock_quantity, subcategory_id, 
            image_urls, fy_video_id, attributes_data,
            shipping_options // NOVO: Array de opções de frete [ { city_id, cost } ]
        } = req.body;

        if (!name || !price || !subcategory_id) {
            return res.status(400).json({ success: false, message: 'Nome, Preço e Subcategoria são obrigatórios.' });
        }
        
        // Processamento das imagens
        const { primaryImageUrl, detailImageUrlsJson, fyVideoId } = processMediaUrls(image_urls, fy_video_id);
        
        const finalPrice = parseFloat(price) + TOTAL_ADDITION; 
        const attributesJson = attributes_data ? JSON.stringify(attributes_data) : null;
        
        // NOVO: Serializa as opções de frete (se houver)
        const shippingOptionsJson = shipping_options && shipping_options.length > 0 ? JSON.stringify(shipping_options) : null;


        const [result] = await pool.execute(
            `INSERT INTO products 
            (seller_id, name, description, price, stock_quantity, subcategory_id, image_url, fy_video_id, attributes_data, detail_image_urls, shipping_options) 
             -- O CAMPO 'shipping_options' FOI ADICIONADO AO DB
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            [
                seller_id, 
                name, 
                description || null,    
                finalPrice, 
                stock_quantity || null, 
                subcategory_id || null,
                primaryImageUrl,        // Imagem Principal
                fyVideoId,              // ID do vídeo (se houver)
                attributesJson,
                detailImageUrlsJson,     // Imagens de Detalhe (JSON)
                shippingOptionsJson      // NOVO: Opções de Frete (JSON)
            ]
        );
        
        res.status(201).json({ 
            success: true, 
            message: 'Produto criado com sucesso. Opções de frete salvas.', 
            product_id: result.insertId 
        });

    } catch (error) {
        console.error('[PRODUCTS] ERRO ao criar produto:', error);
        // CRÍTICO: Se o erro for 'Unknown column', a migração SQL não foi feita.
        if (error.code === 'ER_BAD_FIELD_ERROR') {
             return res.status(500).json({ success: false, message: "Erro de DB: Coluna 'shipping_options' não encontrada. Execute a migração SQL!" });
        }
        res.status(500).json({ success: false, message: 'Erro interno ao salvar produto.' });
    }
});


// 2. Rota para LER a lista de produtos (PÚBLICA - COM FILTRO DE CIDADE)
router.get('/products', async (req, res) => {
    const categoryId = req.query.category_id;
    const subcategoryId = req.query.subcategory_id;
    
    let whereClause = 'WHERE p.is_active = TRUE';
    const queryParams = [];
    
    let buyerCityId = null;

    // 1. Tenta obter o city_id do usuário logado através do token
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer') && JWT_SECRET) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET);

            const [userRows] = await pool.execute(
                `SELECT city_id FROM users WHERE id = ? LIMIT 1`,
                [decoded.id]
            );
            if (userRows.length > 0 && userRows[0].city_id) {
                buyerCityId = userRows[0].city_id;
                console.log(`[PRODUCTS/GET] Usuário logado detectado. Filtrando por City ID: ${buyerCityId}`);
            }
        } catch (error) {
            // Ignora erro de token inválido para continuar exibindo produtos (sem filtro estrito)
            console.warn('[PRODUCTS/GET] Token presente, mas inválido/expirado. Sem City ID para filtro.');
        }
    }

    // 2. Aplica Filtros de Categoria/Subcategoria
    if (categoryId) {
        whereClause += ' AND s.category_id = ?';
        queryParams.push(categoryId);
    }
    
    if (subcategoryId) {
        whereClause += ' AND p.subcategory_id = ?';
        queryParams.push(subcategoryId);
    }
    
    // 3. CRÍTICO: Aplica o Filtro de Cidade
    if (buyerCityId) {
        // Filtra produtos onde o campo 'shipping_options' contém o ID da cidade do comprador.
        // O ID é convertido para string pois o JSON_CONTAINS busca o valor exato no JSON.
        whereClause += ` AND JSON_CONTAINS(p.shipping_options, ?, '$.city_id')`;
        queryParams.push(JSON.stringify(buyerCityId.toString())); 
        console.log(`[PRODUCTS/GET] Filtro de Frete Ativo: City ID ${buyerCityId}`);
        
    } else {
        // Fallback: Se o usuário não estiver logado, ele só verá produtos que não tem restrição
        // OU produtos que atendem ao ID de uma cidade padrão (Ex: ID 1).
        // A busca é por ID 1 como string, assumindo que 1 é o ID da cidade mais comum.
        whereClause += ` AND (p.shipping_options IS NULL OR JSON_CONTAINS(p.shipping_options, ?, '$.city_id'))`;
        queryParams.push(JSON.stringify('1'));
        console.log(`[PRODUCTS/GET] Filtro de Frete Inativo: Fallback para City ID 1 ou Sem Restrição.`);
    }
    
    try {
        // Selecionando a nova coluna 'detail_image_urls' E 'shipping_options'
        const query = `
            SELECT p.*, p.shipping_options, s.id AS store_id, s.name AS store_name, u.full_name AS seller_name, u.city 
            FROM products p
            JOIN stores s ON p.seller_id = s.seller_id
            JOIN users u ON p.seller_id = u.id
            ${whereClause}
        `;
        
        const [products] = await pool.execute(query, queryParams);
        
        // Tratar o campo detail_image_urls e shipping_options de volta para array no retorno
        const productsWithParsedDetails = products.map(parseProductDetails);

        res.status(200).json({ success: true, count: products.length, products: productsWithParsedDetails });

    } catch (error) {
        console.error('[PRODUCTS] ERRO ao buscar produtos públicos com filtros:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar produtos.' });
    }
});


// 3. Rota para BUSCAR PRODUTO POR ID (PÚBLICA - PARA product_page.html)
router.get('/products/:id', async (req, res) => {
    const productId = req.params.id;

    try {
        const [rows] = await pool.execute(
            `SELECT p.*, p.shipping_options, s.id AS store_id, s.name AS store_name, u.full_name AS seller_name, u.city 
             FROM products p
             JOIN stores s ON p.seller_id = s.seller_id
             JOIN users u ON p.seller_id = u.id
             WHERE p.id = ? AND p.is_active = TRUE LIMIT 1`,
            [productId]
        );

        let product = rows[0];

        if (!product) {
            return res.status(404).json({ success: false, message: 'Produto não encontrado ou inativo.' });
        }

        // Tratar os campos JSON de volta para array
        product = parseProductDetails(product);

        res.status(200).json({ success: true, product });

    } catch (error) {
        console.error('[PRODUCTS/:ID] ERRO ao buscar produto por ID:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao carregar o produto.' });
    }
});


// 4. Rota para LER os produtos DE UM LOJISTA (PROTEGIDA - PARA painel.html)
router.get('/products/store/:sellerId', protectSeller, async (req, res) => {
    const seller_id = req.params.sellerId;

    if (req.user.id.toString() !== seller_id) {
         return res.status(403).json({ success: false, message: 'Acesso negado. Você não tem permissão para ver estes produtos.' });
    }
    
    try {
        // Selecionando a nova coluna 'detail_image_urls' E 'shipping_options'
        const [products] = await pool.execute(
            'SELECT *, shipping_options FROM products WHERE seller_id = ? ORDER BY created_at DESC',
            [seller_id]
        );
        
        // Tratar os campos JSON de volta para array
        const productsWithParsedDetails = products.map(parseProductDetails);

        res.status(200).json({ success: true, products: productsWithParsedDetails });
    } catch (error) {
        console.error('[PRODUCTS/STORE] Erro ao buscar produtos da loja:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar produtos.' });
    }
});


// 5. Rota para ATUALIZAR um produto (PROTEGIDA)
router.put('/products/:id', protectSeller, async (req, res) => {
    const productId = req.params.id;
    const seller_id = req.user.id; 
    
    // Desestruturação dos dados (INCLUSÃO DE shipping_options)
    const { 
        name, description, price, stock_quantity, subcategory_id, 
        image_urls, is_active, fy_video_id, attributes_data,
        shipping_options // NOVO: Array de opções de frete
    } = req.body;
    
    // Processamento das imagens
    const { primaryImageUrl, detailImageUrlsJson, fyVideoId } = processMediaUrls(image_urls, fy_video_id);

    const finalPrice = parseFloat(price) + TOTAL_ADDITION; 
    const attributesJson = attributes_data ? JSON.stringify(attributes_data) : null;
    
    // NOVO: Serializa as opções de frete (se houver)
    const shippingOptionsJson = shipping_options && shipping_options.length > 0 ? JSON.stringify(shipping_options) : null;


    try {
        const [result] = await pool.execute(
            `UPDATE products SET 
             name=?, description=?, price=?, stock_quantity=?, subcategory_id=?, image_url=?, is_active=?, fy_video_id=?, attributes_data=?, detail_image_urls=?, shipping_options=?
             WHERE id=? AND seller_id=?`, 
            [
                name, 
                description || null,    
                finalPrice, 
                stock_quantity || null, 
                subcategory_id || null, 
                primaryImageUrl,        // Imagem Principal
                is_active, 
                fyVideoId,              // ID do vídeo (se houver)
                attributesJson, 
                detailImageUrlsJson,    // Imagens de Detalhe (JSON)
                shippingOptionsJson,    // NOVO: Opções de Frete (JSON)
                productId, 
                seller_id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Produto não encontrado ou você não tem permissão para editar.' });
        }

        res.status(200).json({ success: true, message: 'Produto atualizado com sucesso. Opções de frete salvas.' });

    } catch (error) {
        console.error('[PRODUCTS] ERRO ao atualizar produto:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar produto.' });
    }
});


// 6. Rota para DELETAR (inativar) um produto (PROTEGIDA)
router.delete('/products/:id', protectSeller, async (req, res) => {
    const productId = req.params.id;
    const seller_id = req.user.id; 

    try {
        // Soft delete (apenas marca como inativo)
        const [result] = await pool.execute(
            'UPDATE products SET is_active = FALSE WHERE id = ? AND seller_id = ?',
            [productId, seller_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Produto não encontrado ou você não tem permissão para inativar.' });
        }

        res.status(200).json({ success: true, message: 'Produto inativado (soft delete) com sucesso.' });

    } catch (error) {
        console.error('[PRODUCTS] ERRO ao deletar produto:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao deletar produto.' });
    }
});

module.exports = router;
