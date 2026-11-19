// ETL: PostgreSQL (relacional)  ->  MongoDB (documental)
// Por cada KPI del catalogo (kpis.js) se ejecuta un operador independiente:
//   1) EXTRACT   : consulta SQL a PostgreSQL (con RLS: solo datos del negocio)
//   2) TRANSFORM : calculo del indicador en Node.js
//   3) LOAD      : upsert del resultado en MongoDB -> coleccion kpi_resultados
// Cada paso queda registrado (filas, milisegundos, estado) en la coleccion etl_log.
// Ademas se cargan dos colecciones de documentos: catalogo_productos y ventas_resumen (esta ultima la usa Python).
// Uso:  npm run etl   (todos los negocios)   |   boton "Refresh data" del dashboard (un negocio)
require('dotenv').config();
const crypto = require('crypto');
const { pool, withTenantTransaction } = require('./db');
const { getMongo, closeMongo } = require('./mongo');
const { KPIS, catalogoPublico } = require('./kpis');

const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

const query = (tenantId, sql) => withTenantTransaction({ tenantId, perfilId: 0 }, async (client) => (await client.query(sql)).rows);

async function ensureIndexes(db) {
    await db.collection('kpi_catalogo').createIndex({ codigo: 1 }, { unique: true });
    await db.collection('kpi_resultados').createIndex({ tenant_id: 1, codigo: 1 }, { unique: true });
    await db.collection('etl_log').createIndex({ tenant_id: 1, run_id: 1 });
    await db.collection('catalogo_productos').createIndex({ tenant_id: 1, producto_id: 1 }, { unique: true });
    await db.collection('ventas_resumen').createIndex({ tenant_id: 1, fecha: 1 });
}

function summarize(resultado) {
    if (resultado.items) return `${resultado.items.length} elementos`;
    if (resultado.puntos) return `${resultado.puntos.length} puntos`;
    return resultado.valor === null || resultado.valor === undefined ? 'sin datos' : String(resultado.valor);
}

// ---------- Operadores de KPI ----------
async function runKpiOperators(db, tenantId, runId, now) {
    const steps = [];
    for (const kpi of KPIS.filter((k) => k.sql)) {
        const step = {
            tenant_id: tenantId, run_id: runId, codigo: kpi.codigo, nombre: kpi.nombre, roles: kpi.roles,
            operador: 'Node.js (etl.js)', fuente: kpi.tablas, coleccion_destino: 'kpi_resultados', inicio: new Date(),
        };
        try {
            const t0 = Date.now();
            const rows = await query(tenantId, kpi.sql);                       // EXTRACT
            step.filas_extraidas = rows.length;
            step.ms_extract = Date.now() - t0;

            const t1 = Date.now();
            const resultado = kpi.transform(rows, { now });                    // TRANSFORM
            step.ms_transform = Date.now() - t1;

            const t2 = Date.now();
            await db.collection('kpi_resultados').replaceOne(                  // LOAD
                { tenant_id: tenantId, codigo: kpi.codigo },
                { tenant_id: tenantId, codigo: kpi.codigo, nombre: kpi.nombre, roles: kpi.roles, visual: kpi.visual, resultado, generado_en: now, run_id: runId },
                { upsert: true }
            );
            step.ms_load = Date.now() - t2;
            step.resultado_resumen = summarize(resultado);
            step.estado = 'OK';
        } catch (error) {
            step.estado = 'ERROR';
            step.error = error.message;
        }
        step.fin = new Date();
        steps.push(step);
    }
    return steps;
}

// ---------- Colecciones de documentos (datos relacionales -> documentos) ----------
async function loadDocuments(db, tenantId, runId) {
    const steps = [];
    const base = { tenant_id: tenantId, run_id: runId, roles: [], operador: 'Node.js (etl.js)' };

    // D1: catalogo de productos con categoria, proveedor, unidad y variantes anidadas
    let t = Date.now();
    const productos = await query(tenantId, `
        SELECT p.producto_id, p.nombre, p.precio, p.costo, p.stock, p.referencia_almacen,
               c.nombre AS categoria, pr.nombre AS proveedor, u.nombre AS unidad
        FROM app.productos p
        LEFT JOIN app.categorias c ON c.tenant_id = p.tenant_id AND c.categoria_id = p.categoria_id
        LEFT JOIN app.proveedores pr ON pr.tenant_id = p.tenant_id AND pr.proveedor_id = p.proveedor_id
        LEFT JOIN app.unidades_medida u ON u.unidad_id = p.unidad_id ORDER BY p.producto_id`);
    const variantes = await query(tenantId, `
        SELECT v.variante_id, v.producto_id, v.nombre, v.tamano, v.color, v.referencia, COALESCE(i.existencias_actuales, 0) AS existencias
        FROM app.variantes_producto v LEFT JOIN app.inventario i ON i.tenant_id = v.tenant_id AND i.variante_id = v.variante_id`);
    const msExtract = Date.now() - t;
    t = Date.now();
    const docs = productos.map((p) => ({
        tenant_id: tenantId, producto_id: p.producto_id, nombre: p.nombre, referencia: p.referencia_almacen,
        precio: num(p.precio), costo: num(p.costo), stock: p.stock,
        categoria: p.categoria, proveedor: p.proveedor, unidad: p.unidad,
        atributos: {},                                   // espacio para atributos flexibles (talla, color, especificaciones)
        variantes: variantes.filter((v) => v.producto_id === p.producto_id).map((v) => ({
            id: v.variante_id, nombre: v.nombre, tamano: v.tamano, color: v.color, referencia: v.referencia, existencias: v.existencias,
        })),
    }));
    const msTransform = Date.now() - t;
    t = Date.now();
    await db.collection('catalogo_productos').deleteMany({ tenant_id: tenantId });
    if (docs.length) await db.collection('catalogo_productos').insertMany(docs);
    steps.push({ ...base, codigo: 'D1', nombre: 'Catalogo documental de productos', fuente: ['productos', 'categorias', 'proveedores', 'variantes_producto'],
        coleccion_destino: 'catalogo_productos', filas_extraidas: productos.length, ms_extract: msExtract, ms_transform: msTransform,
        ms_load: Date.now() - t, resultado_resumen: `${docs.length} documentos`, estado: 'OK', inicio: new Date(), fin: new Date() });

    // D2: ventas con sus items anidados (insumo del analisis en Python)
    t = Date.now();
    const ventas = await query(tenantId, `
        SELECT v.venta_id, v.fecha_venta, v.estado, c.cliente_id, c.nombre_completo AS cliente,
               (SELECT m.nombre FROM app.pagos pg JOIN app.metodos_pago m ON m.metodo_pago_id = pg.metodo_pago_id
                 WHERE pg.tenant_id = v.tenant_id AND pg.venta_id = v.venta_id ORDER BY pg.pago_id LIMIT 1) AS metodo_pago,
               COALESCE(json_agg(json_build_object('producto_id', i.producto_id, 'nombre', p.nombre, 'categoria', cat.nombre,
                   'cantidad', i.cantidad, 'precio_unitario', i.precio_unitario, 'costo_unitario', i.costo_unitario, 'subtotal', i.subtotal))
                   FILTER (WHERE i.item_id IS NOT NULL), '[]') AS items
        FROM app.ventas v
        LEFT JOIN app.clientes c ON c.tenant_id = v.tenant_id AND c.cliente_id = v.cliente_id
        LEFT JOIN app.items_venta i ON i.tenant_id = v.tenant_id AND i.venta_id = v.venta_id
        LEFT JOIN app.productos p ON p.tenant_id = i.tenant_id AND p.producto_id = i.producto_id
        LEFT JOIN app.categorias cat ON cat.tenant_id = p.tenant_id AND cat.categoria_id = p.categoria_id
        GROUP BY v.venta_id, v.fecha_venta, v.estado, c.cliente_id, c.nombre_completo
        ORDER BY v.fecha_venta, v.venta_id`);
    const msExtract2 = Date.now() - t;
    t = Date.now();
    const ventaDocs = ventas.map((v) => {
        const items = v.items.map((i) => ({ ...i, categoria: i.categoria || 'Sin categoria', cantidad: num(i.cantidad), precio_unitario: num(i.precio_unitario), costo_unitario: num(i.costo_unitario), subtotal: num(i.subtotal) }));
        const total = r2(items.reduce((s, i) => s + i.subtotal, 0));
        const costo = r2(items.reduce((s, i) => s + i.cantidad * i.costo_unitario, 0));
        return { tenant_id: tenantId, venta_id: v.venta_id, fecha: new Date(v.fecha_venta), estado: v.estado,
            cliente: v.cliente_id ? { id: v.cliente_id, nombre: v.cliente } : null, metodo_pago: v.metodo_pago || 'N/A', total, costo, utilidad: r2(total - costo), items };
    });
    const msTransform2 = Date.now() - t;
    t = Date.now();
    await db.collection('ventas_resumen').deleteMany({ tenant_id: tenantId });
    if (ventaDocs.length) await db.collection('ventas_resumen').insertMany(ventaDocs);
    steps.push({ ...base, codigo: 'D2', nombre: 'Ventas con items anidados', fuente: ['ventas', 'items_venta', 'clientes', 'pagos'],
        coleccion_destino: 'ventas_resumen', filas_extraidas: ventas.length, ms_extract: msExtract2, ms_transform: msTransform2,
        ms_load: Date.now() - t, resultado_resumen: `${ventaDocs.length} documentos`, estado: 'OK', inicio: new Date(), fin: new Date() });
    return steps;
}

async function runEtl(tenantId) {
    const db = await getMongo();                         // falla rapido si MongoDB esta apagado
    const runId = crypto.randomUUID();
    const now = new Date();
    await ensureIndexes(db);

    // Documentacion de los KPI guardada tambien en MongoDB
    for (const kpi of catalogoPublico()) {
        await db.collection('kpi_catalogo').replaceOne({ codigo: kpi.codigo }, kpi, { upsert: true });
    }

    const steps = [...await runKpiOperators(db, tenantId, runId, now), ...await loadDocuments(db, tenantId, runId)];

    // etl_log conserva solo la ultima corrida de cada negocio
    await db.collection('etl_log').deleteMany({ tenant_id: tenantId });
    await db.collection('etl_log').insertMany(steps.map((s, orden) => ({ ...s, orden })));

    return {
        run_id: runId, generado_en: now,
        kpis_ok: steps.filter((s) => s.estado === 'OK' && s.codigo.startsWith('K')).length,
        errores: steps.filter((s) => s.estado === 'ERROR').length,
        productos: steps.find((s) => s.codigo === 'D1').filas_extraidas,
        ventas: steps.find((s) => s.codigo === 'D2').filas_extraidas,
    };
}

module.exports = { runEtl };

if (require.main === module) {
    (async () => {
        try {
            const tenants = await pool.query('SELECT tenant_id FROM app.tenants ORDER BY tenant_id');
            for (const t of tenants.rows) {
                const r = await runEtl(t.tenant_id);
                console.log(`✅ ETL tenant ${t.tenant_id}: ${r.kpis_ok} KPI cargados, ${r.productos} productos, ${r.ventas} ventas, ${r.errores} errores`);
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
