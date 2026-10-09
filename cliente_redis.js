const { createClient } = require('redis');

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
});

redisClient.on('error', (error) => console.error('❌ Error en el cliente Redis:', error.message));
redisClient.on('connect', () => console.log('✅ Conectado a Redis exitosamente.'));

const redisReady = redisClient.connect();

module.exports = { redisClient, redisReady };