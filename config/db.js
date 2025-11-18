// ! Arquivo: config/db.js
const mysql = require('mysql2/promise');

// ! Configuração do Banco de Dados
const dbConfig = { 
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}; 

// ! Criação do Pool ÚNICO
console.log("Criando pool de conexão compartilhado com o MySQL...");
const pool = mysql.createPool(dbConfig);

// ! Exporta o pool para ser usado em outros arquivos
module.exports = pool;
