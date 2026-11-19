require('dotenv').config();
const path = require('path');
const express = require('express');
const routes = require('./routes');
const { pool } = require('./db');
const { closeMongo } = require('./mongo');
const { redisClient } = require('./cliente_redis');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Valid API Routes
app.use('/api', routes);

// Because this is placed after the valid routes, any unmatched /api/... request falls here
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API route not found' });
});

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        return res.json({ status: 'ok' });
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return res.status(503).json({ status: 'unavailable' });
    }
});

// 3. Unified Global Error Handler 
app.use((err, req, res, next) => {
    console.error('❌ Backend Crash:', err.stack);
    if (res.headersSent) {
        return next(err);
    }
    return res.status(500).json({ 
        error: 'Internal Server Error', 
        details: err.message 
    });
});

const server = app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});

function closeServer() {
    server.close(async () => {
        try {
            await closeMongo();
            if (redisClient.isOpen) await redisClient.quit();
        } catch (error) {
            console.error('Error al cerrar conexiones:', error.message);
        }
        await pool.end();
        process.exit(0);
    });
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);

module.exports = app;
