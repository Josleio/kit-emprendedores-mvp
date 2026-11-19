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
    // ---------------------------- ADMINISTRADOR (4 KPIs en %) ----------------------------
    {
        codigo: 'K01', nombre: 'Disponibilidad saludable de inventario', roles: ['Administrador'], visual: 'tarjeta',
        descripcion: 'Porcentaje de productos con existencias por encima del minimo (> 5 unidades).',
        formula: '(productos con stock > 5 / total productos) x 100',
        tablas: ['productos'],
        sql: `SELECT COUNT(*) FILTER (WHERE stock > 5) AS ok, COUNT(*) AS total FROM app.productos`,
        transform: (rows) => {
            const ok = num(rows[0].ok), total = num(rows[0].total), v = pct(ok, total);
            return { valor: v, unidad: 'percent', nota: `${ok} de ${total} productos > 5 u.`, tono: v >= 90 ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K02', nombre: 'Tasa de rotacion de inventario', roles: ['Administrador'], visual: 'tarjeta',
        descripcion: 'Porcentaje de unidades vendidas frente al total de unidades gestionadas (vendidas + stock).',
        formula: 'unidades vendidas / (unidades vendidas + stock actual) x 100',
        tablas: ['items_venta', 'productos'],
        sql: `SELECT COALESCE((SELECT SUM(i.cantidad) ${ITEMS} WHERE ${VIGENTE}), 0) AS vendidas,
                     COALESCE((SELECT SUM(stock) FROM app.productos), 0) AS stock`,
        transform: (rows) => {
            const vend = num(rows[0].vendidas), st = num(rows[0].stock), v = pct(vend, vend + st);
            return { valor: v, unidad: 'percent', nota: `${vend} vendidas / ${vend + st} totales`, tono: v >= 45 ? 'good' : '' };
        },
    },
    {
        codigo: 'K03', nombre: 'Tasa de anulacion de ventas', roles: ['Administrador'], visual: 'tarjeta',
        descripcion: 'Porcentaje de ventas anuladas sobre el total de ventas registradas.',
        formula: 'ventas anuladas / total de ventas x 100',
        tablas: ['ventas'],
        sql: `SELECT COUNT(*) FILTER (WHERE estado = 'anulada') AS anuladas, COUNT(*) AS total FROM app.ventas`,
        transform: (rows) => {
            const anul = num(rows[0].anuladas), total = num(rows[0].total), v = total ? r2((anul / total) * 100) : 0;
            return { valor: v, unidad: 'percent', nota: `${anul} de ${total} ventas`, tono: v <= 5 ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K04', nombre: 'Tasa de usuarios activos', roles: ['Administrador'], visual: 'tarjeta',
        descripcion: 'Porcentaje de usuarios habilitados en el negocio frente al total de cuentas.',
        formula: 'usuarios activos / total usuarios x 100',
        tablas: ['usuarios'],
        sql: `SELECT COUNT(*) FILTER (WHERE is_active) AS activos, COUNT(*) AS total FROM app.usuarios`,
        transform: (rows) => {
            const act = num(rows[0].activos), total = num(rows[0].total), v = pct(act, total);
            return { valor: v, unidad: 'percent', nota: `${act} de ${total} usuarios activos`, tono: v >= 95 ? 'good' : 'bad' };
        },
    },

    // ------------------------------ GERENTE (4 KPIs en %) ------------------------------
    {
        codigo: 'K05', nombre: 'Margen de utilidad bruta', roles: ['Gerente'], visual: 'tarjeta',
        descripcion: 'Porcentaje de los ingresos netos que queda como utilidad tras descontar costos.',
        formula: '(ingresos - costo vendido) / ingresos x 100',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT COALESCE(SUM(i.subtotal), 0) AS ingresos, COALESCE(SUM(i.cantidad * i.costo_unitario), 0) AS costo ${ITEMS} WHERE ${VIGENTE}`,
        transform: (rows) => {
            const ing = num(rows[0].ingresos), cos = num(rows[0].costo), v = pct(ing - cos, ing);
            return { valor: v, unidad: 'percent', nota: `Utilidad: $${r2(ing - cos)}`, tono: v >= 45 ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K06', nombre: 'ROI de ventas', roles: ['Gerente'], visual: 'tarjeta',
        descripcion: 'Porcentaje de retorno obtenido sobre el costo de la mercancia vendida.',
        formula: '(ingresos - costo vendido) / costo vendido x 100',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT COALESCE(SUM(i.subtotal), 0) AS ingresos, COALESCE(SUM(i.cantidad * i.costo_unitario), 0) AS costo ${ITEMS} WHERE ${VIGENTE}`,
        transform: (rows) => {
            const ing = num(rows[0].ingresos), cos = num(rows[0].costo), v = pct(ing - cos, cos);
            return { valor: v, unidad: 'percent', nota: `Costo invertido: $${r2(cos)}`, tono: v >= 85 ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K07', nombre: 'Crecimiento mensual de ingresos', roles: ['Gerente'], visual: 'tarjeta',
        descripcion: 'Variacion porcentual de ingresos en los ultimos 30 dias frente a los 30 dias previos.',
        formula: '(ingresos 30d - ingresos 30d previos) / ingresos 30d previos x 100',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT v.fecha_venta, SUM(i.subtotal) AS total ${ITEMS}
              WHERE ${VIGENTE} AND v.fecha_venta >= now() - interval '60 days' GROUP BY v.venta_id, v.fecha_venta`,
        transform: (rows, { now }) => {
            const limit = now.getTime() - 30 * 86400000;
            const cur = rows.filter((r) => new Date(r.fecha_venta).getTime() >= limit).reduce((s, r) => s + num(r.total), 0);
            const prev = rows.filter((r) => new Date(r.fecha_venta).getTime() < limit).reduce((s, r) => s + num(r.total), 0);
            const growth = prev > 0 ? r2(((cur - prev) / prev) * 100) : 0;
            return { valor: growth, unidad: 'percent', nota: `$${r2(cur)} vs $${r2(prev)} previos`, tono: growth >= 10 ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K08', nombre: 'Participacion de categoria lider', roles: ['Gerente'], visual: 'barras',
        descripcion: 'Porcentaje que representa cada categoria sobre el total de ingresos.',
        formula: '(ingresos por categoria / ingresos totales) x 100',
        tablas: ['ventas', 'items_venta', 'productos', 'categorias'],
        sql: `SELECT COALESCE(c.nombre, 'Sin categoria') AS categoria, SUM(i.subtotal) AS total ${ITEMS}
              JOIN app.productos p ON p.tenant_id = i.tenant_id AND p.producto_id = i.producto_id
              LEFT JOIN app.categorias c ON c.tenant_id = p.tenant_id AND c.categoria_id = p.categoria_id
              WHERE ${VIGENTE} GROUP BY 1 ORDER BY total DESC`,
        transform: (rows) => {
            const tot = rows.reduce((s, r) => s + num(r.total), 0);
            return { items: rows.map((r) => ({ etiqueta: r.categoria, valor: pct(num(r.total), tot) || 0 })), unidad: 'percent' };
        },
    },

    // ------------------------------ CAJERO (4 KPIs en %) ------------------------------
    {
        codigo: 'K09', nombre: 'Cumplimiento de cuota semanal', roles: ['Cajero'], visual: 'tarjeta',
        descripcion: 'Porcentaje cumplido frente a la meta semanal de ventas ($250).',
        formula: '(ingresos ultimos 7 dias / 250) x 100',
        tablas: ['ventas', 'items_venta'],
        sql: `SELECT COALESCE(SUM(i.subtotal), 0) AS total ${ITEMS} WHERE ${VIGENTE} AND v.fecha_venta >= now() - interval '7 days'`,
        transform: (rows) => {
            const tot = num(rows[0].total), v = pct(tot, 250);
            return { valor: v, unidad: 'percent', nota: `$${r2(tot)} de $250.00 meta`, tono: v >= 100 ? 'good' : '' };
        },
    },
    {
        codigo: 'K10', nombre: 'Participacion de recaudos digitales', roles: ['Cajero'], visual: 'barras',
        descripcion: 'Porcentaje recaudado por cada medio de pago (meta >= 60% entre Tarjeta y Transferencia).',
        formula: '(pagos por metodo / total recaudado) x 100',
        tablas: ['pagos', 'ventas', 'metodos_pago'],
        sql: `SELECT m.nombre, SUM(pg.valor) AS total
              FROM app.pagos pg
              JOIN app.ventas v ON v.tenant_id = pg.tenant_id AND v.venta_id = pg.venta_id
              JOIN app.metodos_pago m ON m.metodo_pago_id = pg.metodo_pago_id
              WHERE ${VIGENTE} GROUP BY m.nombre ORDER BY total DESC`,
        transform: (rows) => {
            const tot = rows.reduce((s, r) => s + num(r.total), 0);
            return { items: rows.map((r) => ({ etiqueta: r.nombre, valor: pct(num(r.total), tot) || 0 })), unidad: 'percent' };
        },
    },
    {
        codigo: 'K11', nombre: 'Efectividad de cierre en caja', roles: ['Cajero'], visual: 'tarjeta',
        descripcion: 'Porcentaje de ventas finalizadas como pagadas sin anulacion.',
        formula: '(ventas pagadas / total ventas) x 100',
        tablas: ['ventas'],
        sql: `SELECT COUNT(*) FILTER (WHERE estado = 'pagada') AS pagadas, COUNT(*) AS total FROM app.ventas`,
        transform: (rows) => {
            const pag = num(rows[0].pagadas), total = num(rows[0].total), v = pct(pag, total);
            return { valor: v, unidad: 'percent', nota: `${pag} de ${total} cerradas`, tono: v >= 95 ? 'good' : 'bad' };
        },
    },
    {
        codigo: 'K12', nombre: 'Cobertura de identificacion de clientes', roles: ['Cajero'], visual: 'tarjeta',
        descripcion: 'Porcentaje de ventas vigentes asociadas a un cliente registrado.',
        formula: '(ventas con cliente_id / ventas vigentes) x 100',
        tablas: ['ventas', 'clientes'],
        sql: `SELECT COUNT(*) FILTER (WHERE cliente_id IS NOT NULL) AS con_cli, COUNT(*) AS total FROM app.ventas WHERE ${VIGENTE}`,
        transform: (rows) => {
            const cc = num(rows[0].con_cli), total = num(rows[0].total), v = pct(cc, total);
            return { valor: v, unidad: 'percent', nota: `${cc} de ${total} con cliente`, tono: v >= 70 ? 'good' : 'bad' };
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
