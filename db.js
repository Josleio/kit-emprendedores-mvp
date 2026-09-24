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

async function withTenantTransaction(context, callback) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
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