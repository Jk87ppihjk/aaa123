// ! Arquivo: uploadRoutes.js (Integrado com CLOUDINARY - CORRIGIDO: Aceita até 10 arquivos)
const express = require('express');
const router = express.Router();
const multer = require('multer');
const cloudinary = require('cloudinary').v2; // SDK do Cloudinary
const streamifier = require('streamifier'); // Para lidar com streams do buffer
const { protectSeller } = require('./sellerAuthMiddleware'); 

// --- Configuração do Cloudinary ---
// O Cloudinary lê as chaves CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// diretamente das variáveis de ambiente.
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- Configuração do Multer para MEMÓRIA ---
// Armazena o arquivo na memória (Buffer) em vez do disco.
const storage = multer.memoryStorage();
// ALTERAÇÃO: MUDAR de upload.single para upload.array para 10 arquivos
const upload = multer({ storage: storage });


// Função auxiliar para upload (promisificada)
let uploadFromBuffer = (buffer, folderName) => {
    return new Promise((resolve, reject) => {
        let stream = cloudinary.uploader.upload_stream({
            folder: folderName,
            resource_type: "auto" // Detecta se é imagem ou vídeo
        }, (error, result) => {
            if (result) {
                resolve(result);
            } else {
                reject(error);
            }
        });
        // Envia o buffer do arquivo para o stream do Cloudinary
        streamifier.createReadStream(buffer).pipe(stream);
    });
};


// 1. Rota para UPLOAD de Mídia (Imagens e Vídeos)
// Rota unificada para simplificar (POST /api/upload/media)
// ALTERAÇÃO: Usa upload.array para aceitar até 10 arquivos no campo 'media_files'
router.post('/upload/media', protectSeller, upload.array('media_files', 10), async (req, res) => {
    // Agora req.files é um array
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: 'Nenhum arquivo de mídia enviado.' });
    }

    try {
        const uploadPromises = req.files.map(file => {
            const folder = file.mimetype.startsWith('video') ? 'fy_videos' : 'marketplace_images';
            return uploadFromBuffer(file.buffer, folder);
        });

        const results = await Promise.all(uploadPromises);
        
        const urls = results.map(result => ({ 
            url: result.secure_url,
            public_id: result.public_id,
            resource_type: result.resource_type
        }));

        res.status(200).json({ 
            success: true, 
            message: `${urls.length} arquivos enviados com sucesso para o Cloudinary.`, 
            files: urls // Retorna um array de objetos {url, public_id, resource_type}
        });

    } catch (error) {
        console.error('Erro ao enviar para o Cloudinary:', error);
        res.status(500).json({ success: false, message: 'Falha no upload para o Cloudinary.' });
    }
});

// 2. Rota para DELETAR Mídia (Opcional, mas útil para gestão)
router.delete('/upload/:publicId', protectSeller, async (req, res) => {
    const publicId = req.params.publicId;
    try {
        await cloudinary.uploader.destroy(publicId);
        res.status(200).json({ success: true, message: 'Arquivo deletado do Cloudinary.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Falha ao deletar arquivo.' });
    }
});


module.exports = router;
