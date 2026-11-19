// ============================================================================
// ETL · FASE 2: TRANSFORMACION   (datos crudos -> documentos listos para MongoDB)
// ----------------------------------------------------------------------------
// Funcion PURA: no consulta ninguna base de datos. Recibe los 4 conjuntos que extrajo
// extract.js y entrega:
//   kpis        : un documento por KPI con su resultado ya calculado y tabulado
//   documentos  : catalogo_productos y ventas_resumen (datos relacionales -> documentos anidados)
//   pasos       : registro de cada calculo (filas, milisegundos, estado) para el etl_log
//
// CONTRATO (el frontend y Python dependen de esta forma; no cambiarla sin actualizarlos):
//   resultado de un KPI segun su "visual" (definido en kpis.js)
//     tarjeta : { valor, unidad, nota?, tono? }          tono: 'good' | 'bad'
//     barras  : { items: [{ etiqueta, valor }], unidad }
//     serie   : { puntos: [{ fecha, valor }], unidad }
//     tabla   : { columnas: [...], filas: [[...]] }       (K14, lo escribe Python)
//   unidad: 'money' | 'percent' | 'unidades' | 'count'
//
// Regla de negocio: las ventas con estado 'anulada' NUNCA cuentan en las metricas financieras,
// y toda division se protege contra denominadores en cero (el resultado queda en null).
// ============================================================================
const { KPIS, NODE, esNode } = require('./kpis');

// ---------------------------------------------------------------------------
// 1. UTILIDADES DE CALCULO
// ---------------------------------------------------------------------------
const DIA = 86400000;                                             // milisegundos de un dia
const num = (v) => Number(v) || 0;                                // DECIMAL llega como texto desde pg
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;   // redondeo a 2 decimales
const pct = (a, b) => (b > 0 ? r2((a / b) * 100) : null);         // porcentaje protegido contra b = 0
const suma = (filas, fn) => filas.reduce((s, f) => s + fn(f), 0);

// Suma un valor por grupo -> Map(grupo -> total)
function sumarPor(filas, claveFn, valorFn) {
    const grupos = new Map();
    for (const f of filas) {
        // Map permite acumular categorias, productos o metodos sin asumir
        // que vienen ordenados desde PostgreSQL.
        const clave = claveFn(f);
        grupos.set(clave, (grupos.get(clave) || 0) + valorFn(f));
    }
    return grupos;
}

// Map -> [{ etiqueta, valor }] ordenado de mayor a menor (desempate por nombre)
const aBarras = (mapa, valorFn = (v) => v) => [...mapa]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([etiqueta, valor]) => ({ etiqueta, valor: valorFn(valor) }));

// 'good' / 'bad' segun un umbral; sin dato (null) no se pinta ni de bueno ni de malo
const tono = (valor, minimoBueno) => (valor === null ? '' : (valor >= minimoBueno ? 'good' : 'bad'));

// Datos derivados que comparten varias formulas (se calculan una sola vez)
function derivar(datos) {
    // lineas de ventas vigentes (no anuladas) que si tienen item
    const lineasVigentes = datos.lineasVenta.filter((l) => l.item_id !== null && l.estado !== 'anulada');

    // una fila por venta vigente con su total
    const porVenta = new Map();
    for (const l of lineasVigentes) {
        // Cada venta puede tener varias lineas; aqui se reduce a una fila
        // para contar ventas y calcular el ticket promedio correctamente.
        if (!porVenta.has(l.venta_id)) {
            porVenta.set(l.venta_id, { venta_id: l.venta_id, fecha: new Date(l.fecha_venta), cliente_id: l.cliente_id, total: 0 });
        }
        porVenta.get(l.venta_id).total += num(l.subtotal);
    }

    // todas las ventas (incluidas anuladas) con su estado
    const estados = new Map();
    for (const l of datos.lineasVenta) {
        if (!estados.has(l.venta_id)) {
            estados.set(l.venta_id, { venta_id: l.venta_id, estado: l.estado, cliente_id: l.cliente_id, fecha: new Date(l.fecha_venta) });
        }
    }
    const ventas = [...estados.values()];
    // ventas vigentes: tambien las que no tienen items (cuentan como venta, con total 0)
    const ventasVigentes = ventas.filter((v) => v.estado !== 'anulada');

    return { lineasVigentes, porVenta, ventas, ventasVigentes };
}

// ---------------------------------------------------------------------------
// 2. FORMULAS DE LOS KPI  (una por codigo; el catalogo kpis.js solo las describe)
// ---------------------------------------------------------------------------
// Cada formula recibe (datos, x, now): los conjuntos extraidos, los datos derivados y la fecha del ETL.
// "conjunto" indica de que conjunto salen las filas (se registra como filas_extraidas en el etl_log).
const FORMULAS = {
    // ------------------------------ CAJERO ------------------------------
    K01: {
        conjunto: 'lineasVenta',
        calcular: (datos, x, now) => {
            const desde = now.getTime() - 7 * DIA;
            const total = suma(x.lineasVigentes.filter((l) => new Date(l.fecha_venta).getTime() >= desde), (l) => num(l.subtotal));
            const ventas = x.ventasVigentes.filter((v) => v.fecha.getTime() >= desde).length;
            return { valor: r2(total), unidad: 'money', nota: `${ventas} ventas en la ultima semana` };
        },
    },
    K02: {
        conjunto: 'lineasVenta',
        calcular: (datos, x) => {
            const total = suma(x.lineasVigentes, (l) => num(l.subtotal));
            const n = x.ventasVigentes.length;
            return { valor: n > 0 ? r2(total / n) : null, unidad: 'money', nota: `${n} ventas vigentes` };
        },
    },
    K03: {
        conjunto: 'lineasVenta',
        calcular: (datos, x) => {
            const unidades = sumarPor(x.lineasVigentes, (l) => l.producto, (l) => num(l.cantidad));
            return { items: aBarras(unidades).slice(0, 5), unidad: 'unidades' };
        },
    },
    K04: {
        conjunto: 'pagos',
        calcular: (datos) => {
            const vigentes = datos.pagos.filter((p) => p.estado !== 'anulada');
            return { items: aBarras(sumarPor(vigentes, (p) => p.metodo, (p) => num(p.valor)), r2), unidad: 'money' };
        },
    },

    // ------------------------------ GERENTE ------------------------------
    K05: {
        conjunto: 'lineasVenta',
        calcular: (datos, x, now) => {
            const limite = now.getTime() - 30 * DIA;
            const limitePrevio = now.getTime() - 60 * DIA;
            const t = (l) => new Date(l.fecha_venta).getTime();
            const actual = suma(x.lineasVigentes.filter((l) => t(l) >= limite), (l) => num(l.subtotal));
            const previo = suma(x.lineasVigentes.filter((l) => t(l) >= limitePrevio && t(l) < limite), (l) => num(l.subtotal));
            const crecimiento = previo > 0 ? r2(((actual - previo) / previo) * 100) : null;
            return {
                valor: r2(actual), unidad: 'money',
                nota: crecimiento === null ? `Sin ventas en los 30 dias previos ($${r2(previo)})` : `${crecimiento}% frente a $${r2(previo)} de los 30 dias previos`,
                tono: crecimiento === null ? '' : (crecimiento >= 0 ? 'good' : 'bad'),
            };
        },
    },
    K06: {
        conjunto: 'lineasVenta',
        calcular: (datos, x) => {
            const ingresos = suma(x.lineasVigentes, (l) => num(l.subtotal));
            const costo = suma(x.lineasVigentes, (l) => num(l.cantidad) * num(l.costo_unitario));
            const valor = pct(ingresos - costo, ingresos);
            return { valor, unidad: 'percent', nota: `Utilidad: $${r2(ingresos - costo)}`, tono: tono(valor, 45) };
        },
    },
    K07: {
        conjunto: 'lineasVenta',
        calcular: (datos, x, now) => {
            const porDia = sumarPor([...x.porVenta.values()], (v) => v.fecha.toISOString().slice(0, 10), (v) => v.total);
            const puntos = [];
            for (let i = 29; i >= 0; i--) {
                const fecha = new Date(now.getTime() - i * DIA).toISOString().slice(0, 10);
                puntos.push({ fecha, valor: r2(porDia.get(fecha) || 0) });
            }
            return { puntos, unidad: 'money' };
        },
    },
    K08: {
        conjunto: 'lineasVenta',
        calcular: (datos, x) => {
            const porCategoria = sumarPor(x.lineasVigentes, (l) => l.categoria || 'Sin categoria', (l) => num(l.subtotal));
            const total = suma([...porCategoria.values()], (v) => v);
            return { items: aBarras(porCategoria, (v) => pct(v, total) || 0), unidad: 'percent' };
        },
    },
    K09: {
        conjunto: 'lineasVenta',
        calcular: (datos, x) => {
            const ingresos = suma(x.lineasVigentes, (l) => num(l.subtotal));
            const costo = suma(x.lineasVigentes, (l) => num(l.cantidad) * num(l.costo_unitario));
            const valor = pct(ingresos - costo, costo);
            return { valor, unidad: 'percent', nota: `Costo invertido: $${r2(costo)}`, tono: tono(valor, 85) };
        },
    },

    // ------------------------------ ADMINISTRADOR ------------------------------
    K10: {
        conjunto: 'productos',
        calcular: (datos) => {
            const total = datos.productos.length;
            const ok = datos.productos.filter((p) => num(p.stock) > 5).length;
            const valor = pct(ok, total);
            return { valor, unidad: 'percent', nota: `${ok} de ${total} productos > 5 u.`, tono: tono(valor, 90) };
        },
    },
    K11: {
        conjunto: 'productos',
        calcular: (datos) => {
            const valor = suma(datos.productos, (p) => num(p.stock) * num(p.costo));
            const unidades = suma(datos.productos, (p) => num(p.stock));
            return { valor: r2(valor), unidad: 'money', nota: `${unidades} unidades en ${datos.productos.length} productos` };
        },
    },
    K12: {
        conjunto: 'lineasVenta',
        calcular: (datos, x) => {
            const anuladas = x.ventas.length - x.ventasVigentes.length;
            const valor = pct(anuladas, x.ventas.length);
            return { valor, unidad: 'percent', nota: `${anuladas} de ${x.ventas.length} ventas`, tono: valor === null ? '' : (valor <= 5 ? 'good' : 'bad') };
        },
    },
    K13: {
        conjunto: 'lineasVenta',
        calcular: (datos, x) => {
            const conCliente = x.ventasVigentes.filter((v) => v.cliente_id !== null && v.cliente_id !== undefined).length;
            const valor = pct(conCliente, x.ventasVigentes.length);
            return { valor, unidad: 'percent', nota: `${conCliente} de ${x.ventasVigentes.length} con cliente`, tono: tono(valor, 70) };
        },
    },
};

// Texto corto del resultado para el etl_log
function resumir(resultado) {
    if (resultado.items) return `${resultado.items.length} elementos`;
    if (resultado.puntos) return `${resultado.puntos.length} puntos`;
    return resultado.valor === null || resultado.valor === undefined ? 'sin datos' : String(resultado.valor);
}

// ---------------------------------------------------------------------------
// 3. DOCUMENTOS PARA MONGODB  (relacional -> documentos anidados)
// ---------------------------------------------------------------------------
// catalogo_productos: un documento por producto con categoria, proveedor, unidad y variantes anidadas
function armarCatalogoProductos(datos, tenantId) {
    // Mongo recibe un documento por producto, con sus variantes dentro del mismo
    // documento para que el catalogo pueda mostrarse sin joins adicionales.
    return datos.productos.map((p) => ({
        tenant_id: tenantId, producto_id: p.producto_id, nombre: p.nombre, referencia: p.referencia_almacen,
        precio: num(p.precio), costo: num(p.costo), stock: num(p.stock),
        categoria: p.categoria, proveedor: p.proveedor, unidad: p.unidad,
        atributos: {},                                   // espacio para atributos flexibles (talla, color, especificaciones)
        variantes: (p.variantes || []).map((v) => ({
            id: v.id, nombre: v.nombre, tamano: v.tamano, color: v.color, referencia: v.referencia, existencias: num(v.existencias),
        })),
    }));
}

// ventas_resumen: un documento por venta (incluidas las anuladas, con su estado) con los items anidados.
// Python lo lee y filtra estado != 'anulada'.
function armarVentasResumen(datos, tenantId) {
    const clientes = new Map(datos.clientes.map((c) => [c.cliente_id, c.nombre_completo]));

    // primer medio de pago de cada venta (los pagos llegan ordenados por pago_id)
    const metodoPorVenta = new Map();
    for (const p of datos.pagos) {
        if (!metodoPorVenta.has(p.venta_id)) metodoPorVenta.set(p.venta_id, p.metodo);
    }

    const ventas = new Map();
    for (const l of datos.lineasVenta) {
        // La primera linea crea el encabezado; las siguientes solo agregan items
        // y actualizan los acumulados de total y costo.
        if (!ventas.has(l.venta_id)) {
            const tieneCliente = l.cliente_id !== null && l.cliente_id !== undefined;
            ventas.set(l.venta_id, {
                tenant_id: tenantId, venta_id: l.venta_id, fecha: new Date(l.fecha_venta), estado: l.estado,
                cliente: tieneCliente ? { id: l.cliente_id, nombre: clientes.get(l.cliente_id) || null } : null,
                metodo_pago: metodoPorVenta.get(l.venta_id) || 'N/A', total: 0, costo: 0, utilidad: 0, items: [],
            });
        }
        if (l.item_id === null) continue;                // venta sin items
        const item = {
            producto_id: l.producto_id, nombre: l.producto, categoria: l.categoria || 'Sin categoria',
            cantidad: num(l.cantidad), precio_unitario: num(l.precio_unitario), costo_unitario: num(l.costo_unitario), subtotal: num(l.subtotal),
        };
        const venta = ventas.get(l.venta_id);
        venta.items.push(item);
        venta.total += item.subtotal;
        venta.costo += item.cantidad * item.costo_unitario;
    }
    return [...ventas.values()].map((v) => ({ ...v, total: r2(v.total), costo: r2(v.costo), utilidad: r2(v.total - v.costo) }));
}

// ---------------------------------------------------------------------------
// 4. TRANSFORMAR  (punto de entrada)
// ---------------------------------------------------------------------------
// transformar(datos, { tenantId, now }) -> { kpis, documentos, pasos }
// Un KPI (o un documento) que falla queda como paso ERROR y NO aborta los demas.
function transformar(datos, { tenantId, now = new Date() }) {
    const kpis = [];
    const pasos = [];

    let derivados = null;
    let errorDerivados = null;
    try {
        derivados = derivar(datos);
    } catch (error) {
        errorDerivados = error;
    }

    // --- KPI de operador Node.js
    for (const kpi of KPIS.filter(esNode)) {
        const formula = FORMULAS[kpi.codigo];
        const paso = {
            codigo: kpi.codigo, nombre: kpi.nombre, fase: 'transformacion', roles: kpi.roles, operador: NODE,
            fuente: kpi.tablas, coleccion_destino: 'kpi_resultados', inicio: new Date(),
        };
        const t0 = Date.now();
        try {
            // Cada KPI se aisla en su propio try/catch: una formula defectuosa
            // queda registrada sin impedir calcular las demas.
            if (!formula) throw new Error(`No existe formula para ${kpi.codigo} en transform.js`);
            if (errorDerivados) throw errorDerivados;
            const resultado = formula.calcular(datos, derivados, now);
            paso.filas_extraidas = datos[formula.conjunto].length;
            paso.resultado_resumen = resumir(resultado);
            paso.estado = 'OK';
            kpis.push({ tenant_id: tenantId, codigo: kpi.codigo, nombre: kpi.nombre, roles: kpi.roles, visual: kpi.visual, resultado });
        } catch (error) {
            paso.estado = 'ERROR';
            paso.error = error.message;
        }
        paso.ms_transform = Date.now() - t0;
        paso.fin = new Date();
        pasos.push(paso);
    }

    // --- Documentos (si uno falla queda en null y la carga lo respeta: no borra lo que ya hay en Mongo)
    const documentos = { catalogo_productos: null, ventas_resumen: null };
    const hacerDocumento = (clave, codigo, nombre, fuente, filas, armar) => {
        const paso = {
            codigo, nombre, fase: 'transformacion', roles: [], operador: NODE, fuente,
            coleccion_destino: clave, inicio: new Date(),
        };
        const t0 = Date.now();
        try {
            // La funcion armar recibe todos los datos, pero solo se invoca aqui
            // para que el fallo de un documento no detenga el otro.
            documentos[clave] = armar();
            paso.filas_extraidas = filas();
            paso.resultado_resumen = `${documentos[clave].length} documentos`;
            paso.estado = 'OK';
        } catch (error) {
            paso.estado = 'ERROR';
            paso.error = error.message;
        }
        paso.ms_transform = Date.now() - t0;
        paso.fin = new Date();
        pasos.push(paso);
    };
    hacerDocumento('catalogo_productos', 'D1', 'Catalogo documental de productos',
        ['productos', 'categorias', 'proveedores', 'variantes_producto'], () => datos.productos.length,
        () => armarCatalogoProductos(datos, tenantId));
    hacerDocumento('ventas_resumen', 'D2', 'Ventas con items anidados',
        ['ventas', 'items_venta', 'clientes', 'pagos'], () => datos.lineasVenta.length,
        () => armarVentasResumen(datos, tenantId));

    return { kpis, documentos, pasos };
}

module.exports = { transformar, transform: transformar, FORMULAS, derivar, armarCatalogoProductos, armarVentasResumen };
