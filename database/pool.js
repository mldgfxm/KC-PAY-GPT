'use strict';

const mysql = require('mysql2/promise');
let pool;

function getPool() {
    if (!pool) {
        pool = mysql.createPool({
            host: process.env.DB_HOST || '127.0.0.1',
            port: Number(process.env.DB_PORT || 3306),
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'gpt',
            charset: 'utf8mb4', connectionLimit: Number(process.env.DB_POOL_LIMIT || 60),
            waitForConnections: true, queueLimit: 0, multipleStatements: true,
            enableKeepAlive: true, keepAliveInitialDelay: 10000
        });
    }
    return pool;
}

module.exports = { getPool };
