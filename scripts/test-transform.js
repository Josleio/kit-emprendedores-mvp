// ============================================================================
// PRUEBAS UNITARIAS DE LA TRANSFORMACION ETL (npm test)
// ----------------------------------------------------------------------------
// Prueba las 13 formulas de Node.js (K01..K13), la exclusion de ventas anuladas,
// la proteccion contra division por cero y la generacion de catalogo_productos
// y ventas_resumen sin depender de PostgreSQL ni MongoDB.
// ============================================================================
const assert = require('assert');
const { transformar } = require('../src/etl/transform');

const now = new Date('2026-11-19T12:00:00Z');
const hace2Dias = new Date(now.getTime() - 2 * 86400000).toISOString();
const hace15Dias = new Date(now.getTime() - 15 * 86400000).toISOString();
const hace40Dias = new Date(now.getTime() - 40 * 86400000).toISOString();

const datosMock = {
    lineasVenta: [
        // Venta 1 (vigente, hace 2 dias, con cliente) -> subtotal 200, costo 100
        { venta_id: 1, fecha_venta: hace2Dias, estado: 'pagada', cliente_id: 10, item_id: 1, producto_id: 1, producto: 'Cuaderno', categoria: 'Papeleria', cantidad: '2', precio_unitario: '100.00', costo_unitario: '50.00', subtotal: '200.00' },
        // Venta 2 (vigente, hace 15 dias, sin cliente) -> subtotal 100, costo 40
        { venta_id: 2, fecha_venta: hace15Dias, estado: 'pagada', cliente_id: null, item_id: 2, producto_id: 2, producto: 'Marcador', categoria: 'Papeleria', cantidad: '1', precio_unitario: '100.00', costo_unitario: '40.00', subtotal: '100.00' },
        // Venta 3 (vigente, hace 40 dias, con cliente) -> subtotal 150, costo 75
        { venta_id: 3, fecha_venta: hace40Dias, estado: 'pagada', cliente_id: 11, item_id: 3, producto_id: 1, producto: 'Cuaderno', categoria: 'Papeleria', cantidad: '3', precio_unitario: '50.00', costo_unitario: '25.00', subtotal: '150.00' },
        // Venta 4 (ANULADA, hace 2 dias) -> NO debe sumar a ingresos
        { venta_id: 4, fecha_venta: hace2Dias, estado: 'anulada', cliente_id: 10, item_id: 4, producto_id: 1, producto: 'Cuaderno', categoria: 'Papeleria', cantidad: '5', precio_unitario: '100.00', costo_unitario: '50.00', subtotal: '500.00' },
    ],
    pagos: [
        { pago_id: 1, venta_id: 1, estado: 'pagada', metodo: 'Efectivo', valor: '200.00' },
        { pago_id: 2, venta_id: 2, estado: 'pagada', metodo: 'Tarjeta', valor: '100.00' },
        { pago_id: 3, venta_id: 3, estado: 'pagada', metodo: 'Efectivo', valor: '150.00' },
        { pago_id: 4, venta_id: 4, estado: 'anulada', metodo: 'Efectivo', valor: '500.00' },
    ],
    productos: [
        { producto_id: 1, nombre: 'Cuaderno', precio: '100.00', costo: '50.00', stock: 10, referencia_almacen: 'A1', categoria: 'Papeleria', proveedor: 'Prov1', unidad: 'Unidad', variantes: [] },
        { producto_id: 2, nombre: 'Marcador', precio: '100.00', costo: '40.00', stock: 3, referencia_almacen: 'A2', categoria: 'Papeleria', proveedor: 'Prov1', unidad: 'Unidad', variantes: [] },
    ],
    clientes: [
        { cliente_id: 10, nombre_completo: 'Laura Gomez' },
        { cliente_id: 11, nombre_completo: 'Carlos Mejia' },
    ],
};

const { kpis, documentos, pasos } = transformar(datosMock, { tenantId: 1, now });
const byCode = Object.fromEntries(kpis.map((k) => [k.codigo, k.resultado]));

assert.strictEqual(kpis.length, 13, 'Deben calcularse 13 KPIs en Node.js');
assert.strictEqual(pasos.filter((p) => p.estado === 'ERROR').length, 0, 'No debe haber errores en pasos');

// Verificaciones puntuales
assert.strictEqual(byCode.K01.valor, 200, 'K01: ventas ultimos 7 dias excluye anuladas');
assert.strictEqual(byCode.K02.valor, 150, 'K02: ticket promedio = 450 / 3');
assert.strictEqual(byCode.K03.items[0].etiqueta, 'Cuaderno', 'K03: Cuaderno es el mas vendido');
assert.strictEqual(byCode.K03.items[0].valor, 5, 'K03: 5 cuadernos vigentes');
assert.strictEqual(byCode.K04.items[0].valor, 350, 'K04: Efectivo = 200 + 150');
assert.strictEqual(byCode.K05.valor, 300, 'K05: ingresos 30d = 200 + 100');
assert.strictEqual(byCode.K06.valor, 52.22, 'K06: margen = (450 - 215) / 450 * 100');
assert.strictEqual(byCode.K07.puntos.length, 30, 'K07: serie de 30 dias');
assert.strictEqual(byCode.K08.items[0].valor, 100, 'K08: 100% Papeleria');
assert.strictEqual(byCode.K09.valor, 109.3, 'K09: ROI = (450 - 215) / 215 * 100');
assert.strictEqual(byCode.K10.valor, 50, 'K10: 1 de 2 productos con stock > 5');
assert.strictEqual(byCode.K11.valor, 620, 'K11: valor inventario = 10*50 + 3*40');
assert.strictEqual(byCode.K12.valor, 25, 'K12: 1 anulada de 4 ventas = 25%');
assert.strictEqual(byCode.K13.valor, 66.67, 'K13: 2 de 3 vigentes con cliente');

// Documentos MongoDB
assert.strictEqual(documentos.catalogo_productos.length, 2, 'catalogo_productos con 2 productos');
assert.strictEqual(documentos.ventas_resumen.length, 4, 'ventas_resumen con 4 ventas (incluye anulada)');
assert.strictEqual(documentos.ventas_resumen[0].cliente.nombre, 'Laura Gomez', 'Cliente anidado resuelto');

// Prueba con datos vacios (denominadores en 0 -> null sin NaN)
const vacio = transformar({ lineasVenta: [], pagos: [], productos: [], clientes: [] }, { tenantId: 1, now });
for (const k of vacio.kpis) {
    if ('valor' in k.resultado && k.resultado.valor !== null) {
        assert.ok(Number.isFinite(k.resultado.valor), `${k.codigo} no debe producir NaN`);
    }
}

console.log('✅ Pruebas unitarias de transform.js (K01..K13 + documentos) superadas.');
