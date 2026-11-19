// ============================================================================
// CONEXION A POSTGRESQL + CONTEXTO DE NEGOCIO (RLS)
// ----------------------------------------------------------------------------
// - pool: conexiones compartidas a PostgreSQL.
// - withTenantTransaction: abre una transaccion y fija dos variables de sesion
//   (app.current_tenant y app.current_perfil). Las politicas RLS del esquema
//   las leen para dejar pasar SOLO las filas del negocio y las acciones que el
//   perfil tiene permitidas (tabla permisos). Todo acceso operativo pasa por aqui.
// ============================================================================
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ ERROR CRÍTICO: No se pudo conectar a PostgreSQL', err.stack);
    } else {
        console.log('✅ Base de datos conectada exitosamente. Hora del servidor DB:', res.rows[0].now);
    }
});

// context   : { tenantId, perfilId }  (perfilId 0 = sin permisos de escritura; sirve para login y para el ETL, que solo lee)
// callback  : recibe el cliente de la transaccion
// options   : { isolation: 'REPEATABLE READ' } hace que todas las consultas vean la misma "foto" de los datos (lo usa el ETL)
const ISOLATIONS = ['REPEATABLE READ', 'SERIALIZABLE'];

async function withTenantTransaction(context, callback, options = {}) {
    const client = await pool.connect();
    const begin = ISOLATIONS.includes(options.isolation) ? `BEGIN ISOLATION LEVEL ${options.isolation}` : 'BEGIN';

    try {
        await client.query(begin);
        await client.query("SELECT set_config('app.current_tenant', $1::text, true)", [String(context.tenantId)]);
        await client.query("SELECT set_config('app.current_perfil', $1::text, true)", [String(context.perfilId)]);

        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            error.rollbackError = rollbackError;
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { pool, withTenantTransaction };
