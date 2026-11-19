// ============================================================================
// DASHBOARD DE KPI  —  IMPLEMENTACION DE MONGODB EN LA APLICACION     Fuente: MongoDB
// ----------------------------------------------------------------------------
// El dashboard NO consulta PostgreSQL para los indicadores: lee los documentos que el ETL
// dejo en MongoDB. Toda consulta a Mongo filtra por tenant_id (aislamiento entre negocios).
//
//   Coleccion MongoDB   Quien la escribe        Quien la lee
//   -----------------   ---------------------   ------------------------------------------
//   kpi_resultados      ETL (Node) y Python     GET /api/analitica/kpis  (tarjetas, barras, series, tabla)
//   kpi_catalogo        ETL (Node)              GET /api/analitica/catalogo
//   etl_log             ETL (Node) y Python     GET /api/analitica/etl-log
//
//   GET  /api/analitica/kpis      permiso: /analitica read     KPI del rol del usuario (Administrador puede ver cualquier rol con ?rol=)
//   GET  /api/analitica/catalogo  permiso: /analitica read     tabla documentada de KPI
//   GET  /api/analitica/etl-log   permiso: /analitica update   pasos de la ultima corrida del ETL
//   POST /api/analitica/etl       permiso: /analitica update   boton "Refresh data": corre el ETL del negocio (PostgreSQL -> MongoDB)
//
// El ROL (app.roles) del perfil decide que dashboard se muestra; el PERFIL decide si la pantalla es accesible.
// ============================================================================
const express = require('express');
const { withTenantTransaction } = require('../../config/postgres');
const { getMongo } = require('../../config/mongo');
const { requireJwt } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permisos');
const { KPIS, ROLES, catalogoPublico } = require('../../etl/kpis');
const { runEtl } = require('../../etl');

const router = express.Router();

// Registra el error en consola (una sola linea) y responde 500 con un mensaje legible para la pantalla
function fallo(res, mensaje, error) {
    console.error(`❌ ${mensaje}:`, error.stack);
    return res.status(500).json({ error: mensaje, details: error.message });
}

// Conecta a Mongo o responde 503 si el servicio esta apagado
async function mongoOr503(res) {
    try {
        return await getMongo();
    } catch (error) {
        res.status(503).json({ error: 'MongoDB is not available. Check that the MongoDB service is running.' });
        return null;
    }
}

// Perfil y rol del usuario (perfiles JOIN roles, dentro del negocio)
async function perfilYRol(auth) {
    return withTenantTransaction(auth, async (client) => (await client.query(`
        SELECT p.nombre AS perfil, r.nombre AS rol
        FROM app.perfiles p JOIN app.roles r ON r.rol_id = p.rol_id
        WHERE p.perfil_id = $1`, [auth.perfilId])).rows[0] || {});
}

// ------------------------------------------------------------------ KPI POR ROL
// permiso: /analitica read
router.get('/analitica/kpis', requireJwt, requirePermission('/analitica', 'read'), async (req, res) => {
    const db = await mongoOr503(res);
    if (!db) return undefined;
    try {
        const { perfil, rol } = await perfilYRol(req.auth);
        const esAdministrador = rol === 'Administrador';
        const rolVista = esAdministrador && ROLES.includes(req.query.rol) ? req.query.rol : rol;

        if (!ROLES.includes(rolVista)) {
            return res.json({ rol, perfil, roles_disponibles: [], kpis_del_rol: 0, resultados: [], sin_rol: true });
        }
        const codigos = KPIS.filter((k) => k.roles.includes(rolVista)).map((k) => k.codigo);

        const resultados = await db.collection('kpi_resultados')
            .find({ tenant_id: req.auth.tenantId, codigo: { $in: codigos } }, { projection: { _id: 0 } })
            .sort({ codigo: 1 })
            .toArray();

        return res.json({
            rol: rolVista,
            perfil,
            kpis_del_rol: codigos.length,
            resultados,
            roles_disponibles: esAdministrador ? ROLES : [rolVista],
        });
    } catch (error) {
        return fallo(res, 'Could not read analytics data', error);
    }
});

// ------------------------------------------------------------------ CATALOGO DE KPI
// Tabla documentada de KPI (la misma que el ETL guarda en MongoDB, coleccion kpi_catalogo)
// permiso: /analitica read
router.get('/analitica/catalogo', requireJwt, requirePermission('/analitica', 'read'), (req, res) => res.json(catalogoPublico()));

// ------------------------------------------------------------------ LOG DEL ETL
// Proceso de la ultima corrida: un paso por extraccion, KPI y documento + el resultado que quedo en MongoDB
// permiso: /analitica update
router.get('/analitica/etl-log', requireJwt, requirePermission('/analitica', 'update'), async (req, res) => {
    const db = await mongoOr503(res);
    if (!db) return undefined;
    try {
        const pasos = await db.collection('etl_log')
            .find({ tenant_id: req.auth.tenantId }, { projection: { _id: 0 } })
            .sort({ orden: 1 })
            .toArray();
        const docs = await db.collection('kpi_resultados')
            .find({ tenant_id: req.auth.tenantId }, { projection: { _id: 0 } })
            .toArray();
        return res.json({ pasos, documentos: Object.fromEntries(docs.map((d) => [d.codigo, d])) });
    } catch (error) {
        return fallo(res, 'Could not read the ETL log', error);
    }
});

// ------------------------------------------------------------------ BOTON "REFRESH DATA"
// Ejecuta el ETL de este negocio: PostgreSQL -> transformacion -> MongoDB (+ Python para K14)
// permiso: /analitica update
router.post('/analitica/etl', requireJwt, requirePermission('/analitica', 'update'), async (req, res) => {
    if (!await mongoOr503(res)) return undefined;
    try {
        return res.json(await runEtl(req.auth.tenantId));
    } catch (error) {
        return fallo(res, 'ETL failed', error);
    }
});

module.exports = router;
