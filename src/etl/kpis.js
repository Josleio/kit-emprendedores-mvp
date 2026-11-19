// ============================================================================
// CATALOGO DE KPI  (solo metadatos: la "hoja de especificacion" de cada indicador)
// ----------------------------------------------------------------------------
// Aqui NO hay SQL ni calculos. Cada KPI se describe con:
//   codigo, nombre, roles (quien lo ve), visual (tarjeta | barras | serie | tabla),
//   descripcion, formula (texto), tablas (de donde salen los datos) y operador (quien lo calcula).
//
// Quien usa este catalogo:
//   - src/etl/transform.js  : calcula cada KPI de operador Node.js con la funcion del mismo codigo
//   - src/etl/load.js       : guarda este catalogo en MongoDB (coleccion kpi_catalogo)
//   - routes/mongo/dashboard: decide que KPI muestra a cada rol
//   - docs/generar_tabla_kpis.js : genera docs/TABLA_KPIS.md
//
// Roles con dashboard: Administrador, Gerente y Cajero (3 o mas KPI por rol). Son los mismos
// nombres del catalogo app.roles de PostgreSQL.
// ============================================================================
const ROLES = ['Administrador', 'Gerente', 'Cajero'];

const NODE = 'Node.js (src/etl)';
const PYTHON = 'Python (analitica/asociacion.py)';

const KPIS = [
    // ------------------------------ CAJERO ------------------------------
    {
        codigo: 'K01', nombre: 'Ventas ultimos 7 dias', roles: ['Cajero'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Total vendido y numero de ventas de la ultima semana.',
        formula: 'SUM(subtotal) de ventas no anuladas con fecha >= hoy - 7 dias',
        tablas: ['ventas', 'items_venta'],
    },
    {
        codigo: 'K02', nombre: 'Ticket promedio', roles: ['Cajero'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Valor promedio de cada venta.',
        formula: 'SUM(subtotal) / COUNT(ventas no anuladas)',
        tablas: ['ventas', 'items_venta'],
    },
    {
        codigo: 'K03', nombre: 'Productos mas vendidos', roles: ['Cajero'], visual: 'barras', operador: NODE,
        descripcion: 'Los 5 productos con mas unidades vendidas.',
        formula: 'SUM(cantidad) por producto, orden descendente, limite 5',
        tablas: ['ventas', 'items_venta', 'productos'],
    },
    {
        codigo: 'K04', nombre: 'Ventas por metodo de pago', roles: ['Cajero'], visual: 'barras', operador: NODE,
        descripcion: 'Dinero recibido segun la forma de pago.',
        formula: 'SUM(valor) de pagos de ventas no anuladas, agrupado por metodo',
        tablas: ['pagos', 'ventas', 'metodos_pago'],
    },

    // ------------------------------ GERENTE ------------------------------
    {
        codigo: 'K05', nombre: 'Ingresos ultimos 30 dias', roles: ['Gerente'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Ingresos del ultimo mes y crecimiento frente a los 30 dias anteriores.',
        formula: '(ingresos 30d - ingresos 30d previos) / ingresos 30d previos x 100',
        tablas: ['ventas', 'items_venta'],
    },
    {
        codigo: 'K06', nombre: 'Margen de utilidad', roles: ['Gerente'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Que porcentaje de lo vendido queda como ganancia.',
        formula: '(ingresos - costo de lo vendido) / ingresos x 100',
        tablas: ['ventas', 'items_venta'],
    },
    {
        codigo: 'K07', nombre: 'Ingresos diarios (30 dias)', roles: ['Gerente'], visual: 'serie', operador: NODE,
        descripcion: 'Ingresos de cada uno de los ultimos 30 dias (los dias sin ventas cuentan como 0).',
        formula: 'SUM(subtotal) de ventas no anuladas, agrupado por dia, ultimos 30 dias',
        tablas: ['ventas', 'items_venta'],
    },
    {
        codigo: 'K08', nombre: 'Participacion por categoria', roles: ['Gerente'], visual: 'barras', operador: NODE,
        descripcion: 'Porcentaje que representa cada categoria sobre el total de ingresos.',
        formula: '(ingresos por categoria / ingresos totales) x 100',
        tablas: ['ventas', 'items_venta', 'productos', 'categorias'],
    },
    {
        codigo: 'K09', nombre: 'ROI de ventas', roles: ['Gerente'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Porcentaje de retorno obtenido sobre el costo de la mercancia vendida.',
        formula: '(ingresos - costo vendido) / costo vendido x 100',
        tablas: ['ventas', 'items_venta'],
    },
    {
        codigo: 'K14', nombre: 'Productos comprados juntos', roles: ['Gerente'], visual: 'tabla', operador: PYTHON,
        descripcion: 'Reglas de asociacion entre productos que aparecen en la misma venta (soporte, confianza y lift).',
        formula: 'soporte = ventas con A y B / ventas; confianza = ventas con A y B / ventas con A; lift = confianza / soporte(B)',
        tablas: ['ventas_resumen (MongoDB)'],
    },

    // ------------------------------ ADMINISTRADOR ------------------------------
    {
        codigo: 'K10', nombre: 'Disponibilidad saludable de inventario', roles: ['Administrador'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Porcentaje de productos con existencias por encima del minimo (> 5 unidades).',
        formula: '(productos con stock > 5 / total productos) x 100',
        tablas: ['productos'],
    },
    {
        codigo: 'K11', nombre: 'Valor del inventario a costo', roles: ['Administrador'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Dinero invertido en la mercancia que hay hoy en bodega.',
        formula: 'SUM(stock x costo) de todos los productos',
        tablas: ['productos'],
    },
    {
        codigo: 'K12', nombre: 'Tasa de anulacion de ventas', roles: ['Administrador'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Porcentaje de ventas anuladas sobre el total de ventas registradas.',
        formula: 'ventas anuladas / total de ventas x 100',
        tablas: ['ventas'],
    },
    {
        codigo: 'K13', nombre: 'Cobertura de identificacion de clientes', roles: ['Administrador'], visual: 'tarjeta', operador: NODE,
        descripcion: 'Porcentaje de ventas vigentes asociadas a un cliente registrado.',
        formula: '(ventas vigentes con cliente_id / ventas vigentes) x 100',
        tablas: ['ventas', 'clientes'],
    },
];

// true si el KPI lo calcula Node.js (transform.js); false si lo calcula Python (K14)
// Esta separacion evita que el transformador de Node intente calcular un indicador
// cuya fuente y algoritmo pertenecen al script de analitica.
const esNode = (kpi) => kpi.operador === NODE;

// Metadatos para mostrar/guardar (kpi_catalogo en MongoDB, GET /api/analitica/catalogo y docs/TABLA_KPIS.md)
function catalogoPublico() {
    // Se devuelve una copia con solo campos publicables; el orden agrupa por rol
    // para que API, dashboard y documentacion presenten la misma lista.
    return KPIS.map((k) => ({
        codigo: k.codigo, nombre: k.nombre, roles: k.roles, descripcion: k.descripcion, formula: k.formula,
        tablas: k.tablas, visual: k.visual, operador: k.operador, coleccion: 'kpi_resultados',
    })).sort((a, b) => ROLES.indexOf(a.roles[0]) - ROLES.indexOf(b.roles[0]) || a.codigo.localeCompare(b.codigo));
}

module.exports = { KPIS, ROLES, NODE, PYTHON, esNode, catalogoPublico };
