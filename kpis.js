// ============================================================================
// CATALOGO DE KPI  (documentacion viva: de aqui salen el ETL, el dashboard y la tabla de KPI)
// Cada KPI es un "operador ETL" con tres pasos:
//   Extract   -> sql        : consulta a PostgreSQL (respeta RLS por negocio)
//   Transform -> transform  : calculo del indicador a partir de las filas extraidas
//   Load      -> el runner (etl.js) guarda el resultado en MongoDB, coleccion kpi_resultados
// Roles con dashboard: Administrador, Gerente y Cajero (3 o mas KPI por rol).
// ============================================================================
const num = (v) => Number(v) || 0;
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const pct = (a, b) => (b > 0 ? r2((a / b) * 100) : null);

const ROLES = ['Administrador', 'Gerente', 'Cajero'];

// Fragmentos SQL reutilizados
const ITEMS = `FROM app.ventas v JOIN app.items_venta i ON i.tenant_id = v.tenant_id AND i.venta_id = v.venta_id`;
const VIGENTE = `v.estado <> 'anulada'`;

const KPIS = [
    // ------------------------------ CAJERO ------------------------------
    {
        codigo: 'K01', nombre: 'Ventas ultimos 7 dias', roles: ['Cajero'], visual: 'tarjeta',
        descripcion: 'Total vendido y numero de ventas de la ultima semana.',
        formula: 'SUM(subtotal) de ventas no anuladas con fecha >= hoy - 7 dias',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT v.venta_id, SUM(i.subtotal) AS total ${ITEMS}
              WHERE ${VIGENTE} AND v.fecha_venta >= now() - interval '7 days' GROUP BY v.venta_id`,
        transform: (rows) => ({ valor: r2(rows.reduce((s, r) => s + num(r.total), 0)), unidad: 'money', nota: `${rows.length} ventas` }),
    },
    {
        codigo: 'K02', nombre: 'Ticket promedio', roles: ['Cajero'], visual: 'tarjeta',
        descripcion: 'Valor promedio de cada venta.',
        formula: 'SUM(subtotal) / COUNT(ventas no anuladas)',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT v.venta_id, SUM(i.subtotal) AS total ${ITEMS} WHERE ${VIGENTE} GROUP BY v.venta_id`,
        transform: (rows) => ({ valor: rows.length ? r2(rows.reduce((s, r) => s + num(r.total), 0) / rows.length) : 0, unidad: 'money', nota: `${rows.length} ventas analizadas` }),
    },
    {
        codigo: 'K03', nombre: 'Productos mas vendidos', roles: ['Cajero'], visual: 'barras',
        descripcion: 'Los 5 productos con mas unidades vendidas.',
        formula: 'SUM(cantidad) por producto, orden descendente, limite 5',
        tablas: ['ventas', 'items_venta', 'productos'],
        sql: `SELECT p.nombre, SUM(i.cantidad) AS unidades ${ITEMS}
              JOIN app.productos p ON p.tenant_id = i.tenant_id AND p.producto_id = i.producto_id
              WHERE ${VIGENTE} GROUP BY p.nombre ORDER BY unidades DESC LIMIT 5`,
        transform: (rows) => ({ items: rows.map((r) => ({ etiqueta: r.nombre, valor: num(r.unidades) })), unidad: 'unidades' }),
    },
    {
        codigo: 'K04', nombre: 'Ventas por metodo de pago', roles: ['Cajero'], visual: 'barras',
        descripcion: 'Dinero recibido segun la forma de pago.',
        formula: 'SUM(valor) de pagos de ventas no anuladas, agrupado por metodo',
        tablas: ['pagos', 'ventas', 'metodos_pago'],
        sql: `SELECT m.nombre, SUM(pg.valor) AS total
              FROM app.pagos pg
              JOIN app.ventas v ON v.tenant_id = pg.tenant_id AND v.venta_id = pg.venta_id
              JOIN app.metodos_pago m ON m.metodo_pago_id = pg.metodo_pago_id
              WHERE ${VIGENTE} GROUP BY m.nombre ORDER BY total DESC`,
        transform: (rows) => ({ items: rows.map((r) => ({ etiqueta: r.nombre, valor: r2(num(r.total)) })), unidad: 'money' }),
    },

    // ------------------------------ GERENTE ------------------------------
    {
        codigo: 'K05', nombre: 'Ingresos ultimos 30 dias', roles: ['Gerente'], visual: 'tarjeta',
        descripcion: 'Ingresos del ultimo mes y crecimiento frente a los 30 dias anteriores.',
        formula: '(ingresos 30d - ingresos 30d previos) / ingresos 30d previos x 100',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT v.fecha_venta, SUM(i.subtotal) AS total ${ITEMS}
              WHERE ${VIGENTE} AND v.fecha_venta >= now() - interval '60 days' GROUP BY v.venta_id, v.fecha_venta`,
        transform: (rows, { now }) => {
            const limit = now.getTime() - 30 * 86400000;
            const current = rows.filter((r) => new Date(r.fecha_venta).getTime() >= limit).reduce((s, r) => s + num(r.total), 0);
            const previous = rows.filter((r) => new Date(r.fecha_venta).getTime() < limit).reduce((s, r) => s + num(r.total), 0);
            const growth = previous > 0 ? r2(((current - previous) / previous) * 100) : null;
            return {
                valor: r2(current), unidad: 'money',
                nota: growth === null ? 'Sin periodo previo para comparar' : `${growth >= 0 ? '+' : ''}${growth}% vs 30 dias previos`,
                tono: growth === null ? '' : growth >= 0 ? 'good' : 'bad',
            };
        },
    },
    {
        codigo: 'K06', nombre: 'Margen de utilidad', roles: ['Gerente'], visual: 'tarjeta',
        descripcion: 'Que porcentaje de lo vendido queda como ganancia.',
        formula: '(ingresos - costo de lo vendido) / ingresos x 100',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT COALESCE(SUM(i.subtotal), 0) AS ingresos, COALESCE(SUM(i.cantidad * i.costo_unitario), 0) AS costo
              ${ITEMS} WHERE ${VIGENTE}`,
        transform: (rows) => {
            const ingresos = num(rows[0].ingresos), costo = num(rows[0].costo);
            return { valor: pct(ingresos - costo, ingresos), unidad: 'percent', nota: `Utilidad: ${r2(ingresos - costo)}`, tono: ingresos >= costo ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K07', nombre: 'ROI de ventas', roles: ['Gerente'], visual: 'tarjeta',
        descripcion: 'Retorno sobre lo invertido en los productos vendidos.',
        formula: '(ingresos - costo de lo vendido) / costo de lo vendido x 100',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT COALESCE(SUM(i.subtotal), 0) AS ingresos, COALESCE(SUM(i.cantidad * i.costo_unitario), 0) AS costo
              ${ITEMS} WHERE ${VIGENTE}`,
        transform: (rows) => {
            const ingresos = num(rows[0].ingresos), costo = num(rows[0].costo);
            return { valor: pct(ingresos - costo, costo), unidad: 'percent', nota: `Invertido: ${r2(costo)}`, tono: ingresos >= costo ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K08', nombre: 'Ingresos por categoria', roles: ['Gerente'], visual: 'barras',
        descripcion: 'Que categorias generan mas dinero.',
        formula: 'SUM(subtotal) agrupado por categoria del producto',
        tablas: ['ventas', 'items_venta', 'productos', 'categorias'],
        sql: `SELECT COALESCE(c.nombre, 'Sin categoria') AS categoria, SUM(i.subtotal) AS total ${ITEMS}
              JOIN app.productos p ON p.tenant_id = i.tenant_id AND p.producto_id = i.producto_id
              LEFT JOIN app.categorias c ON c.tenant_id = p.tenant_id AND c.categoria_id = p.categoria_id
              WHERE ${VIGENTE} GROUP BY 1 ORDER BY total DESC`,
        transform: (rows) => ({ items: rows.map((r) => ({ etiqueta: r.categoria, valor: r2(num(r.total)) })), unidad: 'money' }),
    },
    {
        codigo: 'K09', nombre: 'Ventas por dia (30 dias)', roles: ['Gerente'], visual: 'serie',
        descripcion: 'Evolucion diaria de los ingresos durante el ultimo mes.',
        formula: 'SUM(subtotal) por dia, ultimos 30 dias (dias sin ventas = 0)',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT to_char(v.fecha_venta AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS fecha, SUM(i.subtotal) AS total ${ITEMS}
              WHERE ${VIGENTE} AND v.fecha_venta >= now() - interval '30 days' GROUP BY 1`,
        transform: (rows, { now }) => {
            const byDay = new Map(rows.map((r) => [r.fecha, num(r.total)]));
            const puntos = [];
            for (let d = 29; d >= 0; d--) {
                const fecha = new Date(now.getTime() - d * 86400000).toISOString().slice(0, 10);
                puntos.push({ fecha, valor: r2(byDay.get(fecha) || 0) });
            }
            return { puntos, unidad: 'money' };
        },
    },
    {
        codigo: 'K14', nombre: 'Productos comprados juntos', roles: ['Gerente'], visual: 'tabla',
        descripcion: 'Reglas de asociacion (soporte, confianza y lift) entre productos de una misma venta.',
        formula: 'confianza(A->B) = ventas con A y B / ventas con A;  lift = confianza / soporte(B)',
        tablas: ['ventas_resumen (MongoDB)'],
        operador: 'Python (analitica/analisis.py)',
    },

    // ---------------------------- ADMINISTRADOR ----------------------------
    {
        codigo: 'K10', nombre: 'Valor del inventario', roles: ['Administrador'], visual: 'tarjeta',
        descripcion: 'Dinero invertido en el stock actual.',
        formula: 'SUM(stock x costo) de todos los productos',
        tablas: ['productos'],
        sql: `SELECT COALESCE(SUM(stock * costo), 0) AS valor, COALESCE(SUM(stock), 0) AS unidades FROM app.productos`,
        transform: (rows) => ({ valor: r2(num(rows[0].valor)), unidad: 'money', nota: `${num(rows[0].unidades)} unidades en stock` }),
    },
    {
        codigo: 'K11', nombre: 'Productos con stock bajo', roles: ['Administrador'], visual: 'barras',
        descripcion: 'Productos con 5 unidades o menos, para reponer a tiempo.',
        formula: 'productos con stock <= 5, orden ascendente, limite 8',
        tablas: ['productos'],
        sql: `SELECT nombre, stock FROM app.productos WHERE stock <= 5 ORDER BY stock, nombre LIMIT 8`,
        transform: (rows) => ({ items: rows.map((r) => ({ etiqueta: r.nombre, valor: num(r.stock) })), unidad: 'unidades' }),
    },
    {
        codigo: 'K12', nombre: 'LTV promedio por cliente', roles: ['Administrador'], visual: 'tarjeta',
        descripcion: 'Valor promedio que deja cada cliente a lo largo del tiempo (Customer Lifetime Value).',
        formula: 'SUM(total comprado por cliente) / COUNT(clientes con compras)',
        tablas: ['clientes', 'ventas', 'items_venta'],
        sql: `SELECT c.cliente_id, SUM(i.subtotal) AS total
              FROM app.clientes c
              JOIN app.ventas v ON v.tenant_id = c.tenant_id AND v.cliente_id = c.cliente_id
              JOIN app.items_venta i ON i.tenant_id = v.tenant_id AND i.venta_id = v.venta_id
              WHERE ${VIGENTE} GROUP BY c.cliente_id`,
        transform: (rows) => ({ valor: rows.length ? r2(rows.reduce((s, r) => s + num(r.total), 0) / rows.length) : 0, unidad: 'money', nota: `${rows.length} clientes con compras` }),
    },
    {
        codigo: 'K13', nombre: 'Tasa de anulacion de ventas', roles: ['Administrador'], visual: 'tarjeta',
        descripcion: 'Porcentaje de ventas que se anularon (control de calidad y fraude).',
        formula: 'ventas anuladas / total de ventas x 100',
        tablas: ['ventas'],
        sql: `SELECT COUNT(*) FILTER (WHERE estado = 'anulada') AS anuladas, COUNT(*) AS total FROM app.ventas`,
        transform: (rows) => {
            const anuladas = num(rows[0].anuladas), total = num(rows[0].total);
            return { valor: total ? r2((anuladas / total) * 100) : 0, unidad: 'percent', nota: `${anuladas} de ${total} ventas`, tono: total && anuladas / total > 0.1 ? 'bad' : 'good' };
        },
    },
];

// Metadatos para mostrar/guardar (sin funciones)
function catalogoPublico() {
    return KPIS.map((k) => ({
        codigo: k.codigo, nombre: k.nombre, roles: k.roles, descripcion: k.descripcion, formula: k.formula,
        tablas: k.tablas, visual: k.visual, operador: k.operador || 'Node.js (etl.js)', coleccion: 'kpi_resultados',
    })).sort((a, b) => ROLES.indexOf(a.roles[0]) - ROLES.indexOf(b.roles[0]) || a.codigo.localeCompare(b.codigo));
}

module.exports = { KPIS, ROLES, catalogoPublico };
