// ============================================================================
// ETL · FASE 1: EXTRACCION   (PostgreSQL -> memoria)
// ----------------------------------------------------------------------------
// Toma de PostgreSQL los datos crudos del negocio, SIN calcular ningun KPI.
// Se extraen 4 conjuntos de datos, una sola vez, y de ellos salen los 13 KPI de Node
// y los dos documentos de Mongo (catalogo_productos y ventas_resumen).
//
//   conjunto      una fila por                            lo usan
//   -----------   -------------------------------------   ------------------------------------------
//   lineasVenta   linea de venta (venta + item + producto) K01-K03, K05-K09, K12, K13 y ventas_resumen
//   pagos         pago (con el estado de su venta)        K04 y ventas_resumen
//   productos     producto (con variantes anidadas)       K10, K11 y catalogo_productos
//   clientes      cliente                                 ventas_resumen
//
// Las consultas corren con el contexto del negocio (withTenantTransaction): RLS solo entrega
// las filas de ese negocio. Se usa una transaccion REPEATABLE READ para que los cuatro
// conjuntos salgan de la misma "foto" de la base de datos.
// ============================================================================
const { withTenantTransaction } = require('../config/postgres');

// Cada conjunto: codigo de paso, nombre, tablas de origen y consulta SQL
const CONJUNTOS = [
    {
        clave: 'lineasVenta', paso: 'E1', nombre: 'Extraccion: lineas de venta',
        fuente: ['ventas', 'items_venta', 'productos', 'categorias'],
        // LEFT JOIN: una venta sin items tambien aparece (item_id = null), asi se cuentan todas las ventas
        sql: `
            SELECT v.venta_id, v.fecha_venta, v.estado, v.cliente_id,
                   i.item_id, i.producto_id, p.nombre AS producto, cat.nombre AS categoria,
                   i.cantidad, i.precio_unitario, i.costo_unitario, i.subtotal
            FROM app.ventas v
            LEFT JOIN app.items_venta i ON i.tenant_id = v.tenant_id AND i.venta_id = v.venta_id
            LEFT JOIN app.productos p ON p.tenant_id = i.tenant_id AND p.producto_id = i.producto_id
            LEFT JOIN app.categorias cat ON cat.tenant_id = p.tenant_id AND cat.categoria_id = p.categoria_id
            ORDER BY v.fecha_venta, v.venta_id, i.item_id`,
    },
    {
        clave: 'pagos', paso: 'E2', nombre: 'Extraccion: pagos',
        fuente: ['pagos', 'ventas', 'metodos_pago'],
        sql: `
            SELECT pg.pago_id, pg.venta_id, v.estado, m.nombre AS metodo, pg.valor
            FROM app.pagos pg
            JOIN app.ventas v ON v.tenant_id = pg.tenant_id AND v.venta_id = pg.venta_id
            JOIN app.metodos_pago m ON m.metodo_pago_id = pg.metodo_pago_id
            ORDER BY pg.pago_id`,
    },
    {
        clave: 'productos', paso: 'E3', nombre: 'Extraccion: productos con variantes',
        fuente: ['productos', 'categorias', 'proveedores', 'unidades_medida', 'variantes_producto', 'inventario'],
        sql: `
            SELECT p.producto_id, p.nombre, p.precio, p.costo, p.stock, p.referencia_almacen,
                   c.nombre AS categoria, pr.nombre AS proveedor, u.nombre AS unidad,
                   COALESCE((
                       SELECT json_agg(json_build_object(
                                  'id', vp.variante_id, 'nombre', vp.nombre, 'tamano', vp.tamano, 'color', vp.color,
                                  'referencia', vp.referencia, 'existencias', COALESCE(i.existencias_actuales, 0))
                              ORDER BY vp.variante_id)
                       FROM app.variantes_producto vp
                       LEFT JOIN app.inventario i ON i.tenant_id = vp.tenant_id AND i.variante_id = vp.variante_id
                       WHERE vp.tenant_id = p.tenant_id AND vp.producto_id = p.producto_id
                   ), '[]'::json) AS variantes
            FROM app.productos p
            LEFT JOIN app.categorias c ON c.tenant_id = p.tenant_id AND c.categoria_id = p.categoria_id
            LEFT JOIN app.proveedores pr ON pr.tenant_id = p.tenant_id AND pr.proveedor_id = p.proveedor_id
            LEFT JOIN app.unidades_medida u ON u.unidad_id = p.unidad_id
            ORDER BY p.producto_id`,
    },
    {
        clave: 'clientes', paso: 'E4', nombre: 'Extraccion: clientes',
        fuente: ['clientes'],
        sql: 'SELECT cliente_id, nombre_completo FROM app.clientes ORDER BY cliente_id',
    },
];

// extraer(tenantId) -> { datos, pasos }
//   datos : { lineasVenta, pagos, productos, clientes }   (cada fila tal como la devuelve pg; los DECIMAL llegan como string)
//   pasos : un registro por conjunto (E1..E4) con filas y milisegundos, para el etl_log
// Si una consulta falla, la excepcion sube: sin datos no hay nada que transformar.
async function extraer(tenantId) {
    return withTenantTransaction({ tenantId, perfilId: 0 }, async (client) => {
        const datos = {};
        const pasos = [];
        for (const conjunto of CONJUNTOS) {
            const inicio = new Date();
            const t0 = Date.now();
            datos[conjunto.clave] = (await client.query(conjunto.sql)).rows;
            pasos.push({
                codigo: conjunto.paso, nombre: conjunto.nombre, fase: 'extraccion', roles: [],
                operador: 'Node.js (src/etl/extract.js)', fuente: conjunto.fuente, coleccion_destino: '(memoria)',
                filas_extraidas: datos[conjunto.clave].length, ms_extract: Date.now() - t0,
                resultado_resumen: `${datos[conjunto.clave].length} filas`, estado: 'OK', inicio, fin: new Date(),
            });
        }
        return { datos, pasos };
    }, { isolation: 'REPEATABLE READ' });
}

module.exports = { CONJUNTOS, extraer, extract: extraer };
