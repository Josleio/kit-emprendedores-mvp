// ============================================================================
// VENTAS                                                 Fuente: PostgreSQL (RLS)
// ----------------------------------------------------------------------------
// Una venta es un registro inmutable: se crea, se consulta y solo se puede anular
// (la base de datos bloquea cualquier otro cambio con un trigger y sin politicas DELETE).
//
//   GET   /api/ventas/lookups      permiso: /ventas read     clientes, productos con stock y metodos de pago
//   GET   /api/ventas              permiso: /ventas read     ultimas 100 ventas con total y utilidad
//   GET   /api/ventas/:id          permiso: /ventas read     items de una venta
//   POST  /api/ventas              permiso: /ventas create   registra venta + items + pago + descuenta stock
//   PATCH /api/ventas/:id/anular   permiso: /ventas update   anula y devuelve el stock
// ============================================================================
const express = require('express');
const { withTenantTransaction } = require('../../config/postgres');
const { requireJwt } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permisos');
const { parseId, idOrNull } = require('../../utils/validators');
const { handleRouteError } = require('../../utils/errors');

const router = express.Router();

// permiso: /ventas read
router.get('/ventas/lookups', requireJwt, requirePermission('/ventas', 'read'), async (req, res) => {
    try {
        const data = await withTenantTransaction(req.auth, async (client) => ({
            clientes: (await client.query('SELECT cliente_id, nombre_completo FROM app.clientes ORDER BY nombre_completo')).rows,
            productos: (await client.query('SELECT producto_id, nombre, precio, stock FROM app.productos WHERE stock > 0 ORDER BY nombre')).rows,
            metodos: (await client.query('SELECT metodo_pago_id, nombre FROM app.metodos_pago ORDER BY metodo_pago_id')).rows,
        }));
        return res.json(data);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// permiso: /ventas read
router.get('/ventas', requireJwt, requirePermission('/ventas', 'read'), async (req, res) => {
    try {
        const ventas = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT v.venta_id, v.fecha_venta, v.estado, c.nombre_completo AS cliente,
                       COALESCE(SUM(i.cantidad), 0)::int AS unidades,
                       COALESCE(SUM(i.subtotal), 0) AS total,
                       COALESCE(SUM(i.subtotal - i.cantidad * i.costo_unitario), 0) AS utilidad
                FROM app.ventas v
                LEFT JOIN app.clientes c ON c.tenant_id = v.tenant_id AND c.cliente_id = v.cliente_id
                LEFT JOIN app.items_venta i ON i.tenant_id = v.tenant_id AND i.venta_id = v.venta_id
                GROUP BY v.venta_id, v.fecha_venta, v.estado, c.nombre_completo
                ORDER BY v.fecha_venta DESC, v.venta_id DESC
                LIMIT 100`);
            return result.rows;
        });
        return res.json(ventas);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// permiso: /ventas read
router.get('/ventas/:id', requireJwt, requirePermission('/ventas', 'read'), async (req, res) => {
    const ventaId = parseId(req.params.id);
    if (!ventaId) return res.status(400).json({ error: 'Valid sale id is required' });
    try {
        const items = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT p.nombre, i.cantidad, i.precio_unitario, i.subtotal
                FROM app.items_venta i
                JOIN app.productos p ON p.tenant_id = i.tenant_id AND p.producto_id = i.producto_id
                WHERE i.venta_id = $1 ORDER BY i.item_id`, [ventaId]);
            return result.rows;
        });
        return res.json(items);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// Registrar una venta: todo en una transaccion (venta + items + pago + descuento de stock) o nada.
// permiso: /ventas create
router.post('/ventas', requireJwt, requirePermission('/ventas', 'create'), async (req, res) => {
    const cliente = idOrNull(req.body.cliente_id);
    const metodoId = parseId(req.body.metodo_pago_id);
    const items = req.body.items;
    if (cliente.error || !metodoId || !Array.isArray(items) || items.length === 0 || items.length > 100) {
        return res.status(400).json({ error: 'Payment method and at least one item are required' });
    }

    // Une las lineas repetidas del mismo producto
    const lines = new Map();
    for (const item of items) {
        const productId = parseId(item.producto_id);
        const quantity = Number(item.cantidad);
        if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) {
            return res.status(400).json({ error: 'Each item needs a valid product and a quantity of at least 1' });
        }
        lines.set(productId, (lines.get(productId) || 0) + quantity);
    }

    try {
        const result = await withTenantTransaction(req.auth, async (client) => {
            const productIds = [...lines.keys()];
            const products = await client.query(`
                SELECT producto_id, nombre, precio, costo, stock FROM app.productos
                WHERE producto_id = ANY($1::int[]) ORDER BY producto_id FOR UPDATE`, [productIds]);
            if (products.rows.length !== productIds.length) return { error: 'One or more products do not exist' };
            for (const p of products.rows) {
                if (p.stock < lines.get(p.producto_id)) {
                    return { error: `Not enough stock for ${p.nombre} (available: ${p.stock})` };
                }
            }

            const sale = await client.query(
                `INSERT INTO app.ventas (tenant_id, estado, cliente_id) VALUES ($1, 'pagada', $2) RETURNING venta_id`,
                [req.auth.tenantId, cliente.value]
            );
            const ventaId = sale.rows[0].venta_id;
            let total = 0;
            for (const p of products.rows) {
                const quantity = lines.get(p.producto_id);
                await client.query(`
                    INSERT INTO app.items_venta (tenant_id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario)
                    VALUES ($1, $2, $3, $4, $5, $6)`,
                    [req.auth.tenantId, ventaId, p.producto_id, quantity, p.precio, p.costo]);
                const updated = await client.query('UPDATE app.productos SET stock = stock - $1 WHERE producto_id = $2', [quantity, p.producto_id]);
                if (updated.rowCount !== 1) {
                    const blocked = new Error('Stock update blocked by database policy');
                    blocked.code = '42501';
                    throw blocked;
                }
                total += quantity * Number(p.precio);
            }
            total = Math.round(total * 100) / 100;
            await client.query(
                'INSERT INTO app.pagos (tenant_id, venta_id, metodo_pago_id, valor) VALUES ($1, $2, $3, $4)',
                [req.auth.tenantId, ventaId, metodoId, total]
            );
            return { row: { venta_id: ventaId, total } };
        });
        if (result.error) return res.status(400).json({ error: result.error });
        return res.status(201).json(result.row);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// Anular: la venta no se borra, cambia de estado y el stock vuelve al inventario.
// permiso: /ventas update
router.patch('/ventas/:id/anular', requireJwt, requirePermission('/ventas', 'update'), async (req, res) => {
    const ventaId = parseId(req.params.id);
    if (!ventaId) return res.status(400).json({ error: 'Valid sale id is required' });

    try {
        const result = await withTenantTransaction(req.auth, async (client) => {
            const sale = await client.query('SELECT estado FROM app.ventas WHERE venta_id = $1 FOR UPDATE', [ventaId]);
            if (sale.rows.length === 0) return { notFound: true };
            if (sale.rows[0].estado === 'anulada') return { error: 'The sale is already cancelled' };

            const marked = await client.query(`UPDATE app.ventas SET estado = 'anulada' WHERE venta_id = $1`, [ventaId]);
            if (marked.rowCount !== 1) {
                const blocked = new Error('Sale update blocked by database policy');
                blocked.code = '42501';
                throw blocked;
            }
            const items = await client.query('SELECT producto_id, cantidad FROM app.items_venta WHERE venta_id = $1', [ventaId]);
            for (const item of items.rows) {
                await client.query('UPDATE app.productos SET stock = stock + $1 WHERE producto_id = $2', [item.cantidad, item.producto_id]);
            }
            return { ok: true };
        });
        if (result.notFound) return res.status(404).json({ error: 'Sale not found in this tenant' });
        if (result.error) return res.status(400).json({ error: result.error });
        return res.json({ venta_id: ventaId, estado: 'anulada' });
    } catch (error) {
        return handleRouteError(error, res);
    }
});

module.exports = router;
