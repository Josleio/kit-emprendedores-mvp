// ============================================================================
// REDIS = SESIONES EFIMERAS
// ----------------------------------------------------------------------------
// Un registro por sesion activa usa el username como clave y la contraseña como valor,
// con expiracion automatica.
// Toda la logica de uso esta en src/services/sesiones.js.
// Si Redis esta apagado el sistema sigue funcionando solo con JWT y avisa una vez en consola.
// ============================================================================
require('dotenv').config();
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
