// ============================================================================
// ETL  ·  PostgreSQL  ->  MongoDB          (orquestador: lee como la historia del flujo)
// ----------------------------------------------------------------------------
//   1. EXTRAER     extract.js    PostgreSQL (con RLS)  ->  4 conjuntos de datos crudos del negocio
//   2. TRANSFORMAR transform.js  aplica las formulas de los KPI y arma los documentos para Mongo
//   3. CARGAR      load.js       escribe en MongoDB (kpi_resultados, catalogo_productos, ventas_resumen, ...) y el etl_log
//   4. ANALITICA   Python        analitica/asociacion.py lee ventas_resumen de Mongo y escribe el KPI K14
//
//   kpis.js = catalogo de KPI (que se calcula, para quien y con que formula en texto).
//
// Uso:
//   npm run etl                    ETL de todos los negocios
//   boton "Refresh data"           ETL de un negocio (POST /api/analitica/etl)
//   ETL_PYTHON=off                 omite el paso de Python        PYTHON_BIN=...  fuerza el ejecutable de Python
// ============================================================================
require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pool } = require('../config/postgres');
const { getMongo, closeMongo } = require('../config/mongo');
const { extraer } = require('./extract');
const { transformar } = require('./transform');
const { cargar, registrarPaso } = require('./load');

const execFileAsync = promisify(execFile);
const SCRIPT_PYTHON = path.join(__dirname, '..', '..', 'analitica', 'asociacion.py');

// ---------------------------------------------------------------------------
// FASE 4: ANALITICA AVANZADA EN PYTHON (K14)
// Devuelve un paso de bitacora; si Python no esta disponible el paso queda OMITIDO y el ETL continua.
// ---------------------------------------------------------------------------
async function ejecutarPython(tenantId) {
    const paso = {
        codigo: 'K14', nombre: 'Productos comprados juntos', fase: 'analitica', roles: ['Gerente'],
        operador: 'Python (analitica/asociacion.py)', fuente: ['ventas_resumen (MongoDB)'], coleccion_destino: 'kpi_resultados',
        inicio: new Date(),
    };
    if (String(process.env.ETL_PYTHON).toLowerCase() === 'off') {
        return { ...paso, estado: 'OMITIDO', resultado_resumen: 'Desactivado con ETL_PYTHON=off', fin: new Date() };
    }

    const candidatos = process.env.PYTHON_BIN ? [process.env.PYTHON_BIN] : ['python3', 'python'];
    let ultimoError = 'Python no esta instalado';
    for (const bin of candidatos) {
        try {
            await execFileAsync(bin, [SCRIPT_PYTHON, '--tenant', String(tenantId)], { timeout: 60000 });
            return null;                                   // Python escribio K14 y su propia fila en etl_log
        } catch (error) {
            if (error.code === 'ENOENT') continue;         // ese ejecutable no existe: probar el siguiente
            const detalle = String(error.stderr || error.message).trim().split('\n').filter(Boolean).pop();
            ultimoError = detalle || error.message;
            break;
        }
    }
    return { ...paso, estado: 'OMITIDO', resultado_resumen: `No se ejecuto: ${ultimoError}`, fin: new Date() };
}

// ---------------------------------------------------------------------------
// ORQUESTADOR
// ---------------------------------------------------------------------------
// runEtl(tenantId) -> resumen { run_id, generado_en, kpis_ok, errores, productos, ventas, python }
async function runEtl(tenantId) {
    const db = await getMongo();                         // falla rapido si MongoDB esta apagado
    const runId = crypto.randomUUID();
    const now = new Date();

    // 1. EXTRAER: PostgreSQL -> 4 conjuntos de datos (una sola foto de la base)
    const { datos, pasos: pasosExtraccion } = await extraer(tenantId);

    // 2. TRANSFORMAR: formulas de los KPI + documentos para Mongo (sin tocar ninguna base)
    const { kpis, documentos, pasos: pasosTransformacion } = transformar(datos, { tenantId, now });

    // 3. CARGAR: MongoDB (kpi_resultados, catalogo_productos, ventas_resumen, kpi_catalogo) + etl_log
    const pasos = [...pasosExtraccion, ...pasosTransformacion];
    await cargar(db, { tenantId, runId, now, kpis, documentos, pasos });

    // 4. ANALITICA: Python lee ventas_resumen y escribe K14 (si no esta disponible, el paso queda OMITIDO)
    const omitido = await ejecutarPython(tenantId);
    if (omitido) await registrarPaso(db, tenantId, runId, omitido);

    const pasosNode = pasos.filter((p) => p.codigo.startsWith('K'));
    return {
        run_id: runId, generado_en: now,
        kpis_ok: pasosNode.filter((p) => p.estado === 'OK').length + (omitido ? 0 : 1),
        errores: pasos.filter((p) => p.estado === 'ERROR').length,
        productos: pasos.find((p) => p.codigo === 'E3').filas_extraidas,
        ventas: documentos.ventas_resumen ? documentos.ventas_resumen.length : 0,
        python: omitido ? omitido.estado : 'OK',
    };
}

module.exports = { runEtl };

// CLI: npm run etl  -> corre el ETL de todos los negocios
if (require.main === module) {
    (async () => {
        try {
            const tenants = await pool.query('SELECT tenant_id FROM app.tenants ORDER BY tenant_id');
            for (const t of tenants.rows) {
                const r = await runEtl(t.tenant_id);
                console.log(`✅ ETL tenant ${t.tenant_id}: ${r.kpis_ok} KPI cargados, ${r.productos} productos, ${r.ventas} ventas, ${r.errores} errores (Python: ${r.python})`);
            }
        } catch (error) {
            console.error('❌ ETL fallo:', error.message);
            process.exitCode = 1;
        } finally {
            await closeMongo();
            await pool.end();
        }
    })();
}
