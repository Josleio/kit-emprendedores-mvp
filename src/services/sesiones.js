// ============================================================================
// SESIONES EN REDIS  (todo el uso de Redis de la aplicacion esta en este archivo)
// ----------------------------------------------------------------------------
// Clave : username                       Valor: contraseña             Expira: TTL_SESION segundos
//
//   crearSesion    -> login correcto            (SET ... EX)
//   validarSesion  -> cada peticion autenticada (GET)
//   cerrarSesion   -> logout                    (DEL)
//   estado         -> pantalla Integracion      (PING, SCAN, TTL)
//
// Degradacion elegante: si Redis esta apagado el sistema sigue funcionando solo
// con JWT (validarSesion devuelve true) y la pantalla Integracion lo indica.
// ============================================================================
const { redisClient } = require('../config/redis');

const TTL_SESION = 7200; // segundos: misma duracion para el JWT y para la sesion en Redis

const clave = (tenantId, username) => String(username);
const disponible = () => redisClient.isReady;

async function crearSesion(tenantId, username, password) {
    if (!disponible()) return false;
    await redisClient.set(clave(tenantId, username), String(password), { EX: TTL_SESION });
    return true;
}

async function validarSesion(tenantId, username) {
    if (!disponible()) return true;
    return Boolean(await redisClient.get(clave(tenantId, username)));
}

async function cerrarSesion(tenantId, username) {
    if (disponible()) await redisClient.del(clave(tenantId, username));
}

// Estado de Redis para la pantalla Integracion: latencia, sesiones activas del negocio y vida restante de la sesion actual.
async function estado(tenantId, username) {
    if (!disponible()) {
        return { conectado: false, error: 'Redis is not running: sessions rely only on the JWT.' };
    }
    const t0 = Date.now();
    await redisClient.ping();
    let sesiones = 0;
    for await (const lote of redisClient.scanIterator({ MATCH: '*', COUNT: 100 })) {
        sesiones += Array.isArray(lote) ? lote.length : 1;
    }
    const ttl = await redisClient.ttl(clave(tenantId, username));
    return {
        conectado: true, ms: Date.now() - t0, funcion: 'Sesiones efimeras con expiracion automatica',
        sesiones_activas: sesiones, ttl_sesion_actual_seg: ttl,
    };
}

module.exports = { TTL_SESION, crearSesion, validarSesion, cerrarSesion, estado };
