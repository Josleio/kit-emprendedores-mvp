// Redis = sesiones efimeras (un registro por sesion activa, con expiracion).
// Si Redis esta apagado el sistema sigue funcionando solo con JWT y avisa una vez en consola.
const { createClient } = require('redis');

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    socket: { reconnectStrategy: (retries) => (retries >= 3 ? false : 1000) },
});

let warned = false;
redisClient.on('error', (error) => {
    if (!warned) {
        warned = true;
        console.warn('⚠️  Redis no disponible: las sesiones usaran solo JWT.', error.message);
    }
});
redisClient.on('ready', () => console.log('✅ Conectado a Redis (sesiones activas).'));

const redisReady = redisClient.connect().catch(() => null);

module.exports = { redisClient, redisReady };
