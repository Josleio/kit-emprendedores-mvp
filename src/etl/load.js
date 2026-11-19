// ============================================================================
// ETL · FASE 3: CARGA   (documentos transformados -> MongoDB)
// ----------------------------------------------------------------------------
// Escribe en MongoDB lo que entrego transform.js. Colecciones:
//
//   coleccion            documento                        estrategia de escritura
//   ------------------   ------------------------------   -----------------------------------------------
//   kpi_resultados       1 por KPI y negocio              replaceOne + upsert  (idempotente: indice unico tenant_id + codigo)
//   kpi_catalogo         1 por KPI (documentacion)        replaceOne + upsert  (indice unico codigo)
//   catalogo_productos   1 por producto                   se reemplaza lo del negocio (deleteMany + insertMany)
//   ventas_resumen       1 por venta, con items anidados  se reemplaza lo del negocio (deleteMany + insertMany)
//   etl_log              1 por paso del ETL               se reemplaza la corrida anterior del negocio (conserva K14 de Python)
//
// Cada paso queda registrado en etl_log con filas, milisegundos de cada fase y estado.
// ============================================================================
const { catalogoPublico } = require('./kpis');

// Codigo del paso de bitacora de cada coleccion documental
const PASO_DE_COLECCION = { catalogo_productos: 'D1', ventas_resumen: 'D2' };

// ---------------------------------------------------------------------------
// 1. INDICES (garantizan unicidad y hacen idempotente la carga)
// ---------------------------------------------------------------------------
async function asegurarIndices(db) {
    await db.collection('kpi_catalogo').createIndex({ codigo: 1 }, { unique: true });
    await db.collection('kpi_resultados').createIndex({ tenant_id: 1, codigo: 1 }, { unique: true });
    await db.collection('etl_log').createIndex({ tenant_id: 1, run_id: 1 });
    await db.collection('catalogo_productos').createIndex({ tenant_id: 1, producto_id: 1 }, { unique: true });
    await db.collection('ventas_resumen').createIndex({ tenant_id: 1, fecha: 1 });
}

// ---------------------------------------------------------------------------
// 2. CARGA DE CADA COLECCION
// ---------------------------------------------------------------------------
// Documentacion de los KPI (tambien vive en MongoDB)
async function cargarCatalogo(db) {
    for (const kpi of catalogoPublico()) {
        await db.collection('kpi_catalogo').replaceOne({ codigo: kpi.codigo }, kpi, { upsert: true });
    }
}

// Resultado de un KPI: reemplaza el documento anterior de ese negocio y KPI
async function cargarKpi(db, kpi, { runId, now }) {
    await db.collection('kpi_resultados').replaceOne(
        { tenant_id: kpi.tenant_id, codigo: kpi.codigo },
        { ...kpi, generado_en: now, run_id: runId },
        { upsert: true }
    );
}

// Coleccion documental completa de un negocio
async function cargarDocumentos(db, coleccion, tenantId, documentos) {
    await db.collection(coleccion).deleteMany({ tenant_id: tenantId });
    if (documentos.length) await db.collection(coleccion).insertMany(documentos);
}

// ---------------------------------------------------------------------------
// 3. BITACORA (etl_log)
// ---------------------------------------------------------------------------
// Conserva solo la ultima corrida de cada negocio. K14 (Python) no se toca: lo escribe el script de Python.
async function guardarBitacora(db, tenantId, runId, pasos) {
    await db.collection('etl_log').deleteMany({ tenant_id: tenantId, codigo: { $ne: 'K14' } });
    if (pasos.length) {
        await db.collection('etl_log').insertMany(pasos.map((paso, orden) => ({ ...paso, tenant_id: tenantId, run_id: runId, orden })));
    }
}

// Paso que reemplaza solo su propia fila (lo usa el orquestador cuando Python queda OMITIDO)
async function registrarPaso(db, tenantId, runId, paso, orden = 99) {
    await db.collection('etl_log').deleteMany({ tenant_id: tenantId, codigo: paso.codigo });
    await db.collection('etl_log').insertOne({ ...paso, tenant_id: tenantId, run_id: runId, orden });
}

// ---------------------------------------------------------------------------
// 4. CARGAR  (punto de entrada)
// ---------------------------------------------------------------------------
// cargar(db, { tenantId, runId, now, kpis, documentos, pasos })
//   kpis, documentos : lo que entrego transformar()
//   pasos            : pasos de extraer() + transformar(); aqui se les agrega ms_load y el estado de la carga
// Un KPI cuya carga falla queda como paso ERROR y los demas siguen. Un documento en null
// (su transformacion fallo) se omite: no se borra lo que ya hay en Mongo.
async function cargar(db, { tenantId, runId, now, kpis, documentos, pasos }) {
    await asegurarIndices(db);
    await cargarCatalogo(db);

    const paso = (codigo) => pasos.find((p) => p.codigo === codigo);
    const medir = async (codigo, fn) => {
        const t0 = Date.now();
        try {
            await fn();
        } catch (error) {
            const p = paso(codigo);
            if (p) { p.estado = 'ERROR'; p.error = `Carga: ${error.message}`; }
        }
        const p = paso(codigo);
        if (p) p.ms_load = Date.now() - t0;
    };

    for (const kpi of kpis) {
        await medir(kpi.codigo, () => cargarKpi(db, kpi, { runId, now }));
    }
    const cargados = {};
    for (const [coleccion, docs] of Object.entries(documentos)) {
        if (docs === null) continue;
        await medir(PASO_DE_COLECCION[coleccion], () => cargarDocumentos(db, coleccion, tenantId, docs));
        cargados[coleccion] = docs.length;
    }

    await guardarBitacora(db, tenantId, runId, pasos);
    return { kpis_cargados: kpis.length, documentos: cargados };
}

module.exports = { asegurarIndices, cargarCatalogo, cargarKpi, cargarDocumentos, guardarBitacora, registrarPaso, cargar, load: cargar };
