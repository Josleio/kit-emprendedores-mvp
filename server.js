require('dotenv').config();
const path = require('path');
const express = require('express');
const routes = require('./routes');
const { pool } = require('./db');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        return res.json({ status: 'ok' });
    } catch (error) {
        return res.status(503).json({ status: 'unavailable' });
    }
});

app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) {
        return next(error);
    }
    return res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});

function closeServer() {
    server.close(async () => {
        await pool.end();
        process.exit(0);
    });
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);

module.exports = app;