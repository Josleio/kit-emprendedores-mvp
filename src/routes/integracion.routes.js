// ============================================================================
// INTEGRACION: ESTADO DE POSTGRESQL + REDIS + MONGODB
// ----------------------------------------------------------------------------
//   GET /api/integracion/estado    permiso: /integracion read
// Muestra en vivo que hace cada base de datos en la solucion, su latencia y cuantos
// datos tiene el negocio. Cada base se consulta por separado: si una falla, las otras se muestran igual.
// ============================================================================
const express = require('express');
const { withTenantTransaction } = require('../config/postgres');
const { getMongo } = require('../config/mongo');
const { requireJwt } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permisos');
const sesiones = require('../services/sesiones');

const router = express.Router();

// ---------- PostgreSQL: version, latencia y filas del negocio (con RLS)
async function estadoPostgres(auth) {
    const t0 = Date.now();
    return withTenantTransaction(auth, async (client) => {
        const info = (await client.query(`
            SELECT version() AS version, current_database() AS base,
                   (SELECT count(*) FROM app.productos)::int AS productos,
                   (SELECT count(*) FROM app.clientes)::int AS clientes,
                   (SELECT count(*) FROM app.ventas)::int AS ventas,
                   (SELECT count(*) FROM app.usuarios)::int AS usuarios`)).rows[0];
        return {
            conectado: true, ms: Date.now() - t0, version: info.version.split(' ').slice(0, 2).join(' '), base: info.base,
            funcion: 'Datos transaccionales, RBAC y aislamiento por negocio (RLS)',
            tablas: { productos: info.productos, clientes: info.clientes, ventas: info.ventas, usuarios: info.usuarios },
        };
    });
}

// ---------- MongoDB: latencia, documentos por coleccion del negocio y ultima corrida del ETL
async function estadoMongo(tenantId) {
    const t0 = Date.now();
    const db = await getMongo();
    const colecciones = {};
    for (const name of ['kpi_resultados', 'etl_log', 'catalogo_productos', 'ventas_resumen']) {
        colecciones[name] = await db.collection(name).countDocuments({ tenant_id: tenantId });
    }
    colecciones.kpi_catalogo = await db.collection('kpi_catalogo').countDocuments();
    const last = await db.collection('kpi_resultados').find({ tenant_id: tenantId }).sort({ generado_en: -1 }).limit(1).toArray();
    return {
        conectado: true, ms: Date.now() - t0, base: db.databaseName, funcion: 'Resultados de KPI y documentos analiticos (ETL)',
        colecciones, ultimo_etl: last[0] ? last[0].generado_en : null,
    };
}

// permiso: /integracion read
router.get('/integracion/estado', requireJwt, requirePermission('/integracion', 'read'), async (req, res) => {
    const estado = { postgres: { conectado: false }, redis: { conectado: false }, mongo: { conectado: false } };

    try {
        estado.postgres = await estadoPostgres(req.auth);
    } catch (error) {
        estado.postgres = { conectado: false, error: error.message };
    }

    try {
        estado.redis = await sesiones.estado(req.auth.tenantId, req.auth.jti);
    } catch (error) {
        estado.redis = { conectado: false, error: error.message };
    }

    try {
        estado.mongo = await estadoMongo(req.auth.tenantId);
    } catch (error) {
        estado.mongo = { conectado: false, error: 'MongoDB is not available.' };
    }

    return res.json(estado);
});

module.exports = router;
