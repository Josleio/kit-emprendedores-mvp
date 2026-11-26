// ============================================================================
// CATALOGO Y MAESTROS (productos, clientes, proveedores, categorias)   Fuente: PostgreSQL (RLS)
// ----------------------------------------------------------------------------
// CRUD generico: cada pantalla se declara con una fila de configuracion (tabla, columnas
// editables y validacion) y registerCrud crea las cuatro rutas. Los permisos se verifican
// por pantalla (/catalog, /clientes, ...) y ademas por RLS en la base de datos.
//
//   GET    <ruta>        permiso: <pantalla> read
//   POST   <ruta>        permiso: <pantalla> create
//   PUT    <ruta>/:id    permiso: <pantalla> update
//   DELETE <ruta>/:id    permiso: <pantalla> delete
//
//   Pantallas: /catalog (productos) · /clientes · /proveedores · /categorias
//   GET /api/catalog/lookups   permiso: /catalog read   (listas para los selectores del formulario)
// ============================================================================
const express = require('express');
const { withTenantTransaction } = require('../../config/postgres');
const { requireJwt } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permisos');
const { parseId, idOrNull, optionalText, parsePhone, parseNumber, nameField, collect } = require('../../utils/validators');
const { handleRouteError } = require('../../utils/errors');

const router = express.Router();

function registerCrud({ path, ruta, table, idCol, listSql, parse }) {
    router.get(path, requireJwt, requirePermission(ruta, 'read'), async (req, res) => {
        try {
            const rows = await withTenantTransaction(req.auth, async (client) => (await client.query(listSql)).rows);
            return res.json(rows);
        } catch (error) {
            return handleRouteError(error, res);
        }
    });

    router.post(path, requireJwt, requirePermission(ruta, 'create'), async (req, res) => {
        const parsed = parse(req.body);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const cols = Object.keys(parsed.values);
        try {
            const row = await withTenantTransaction(req.auth, async (client) => {
                const result = await client.query(
                    `INSERT INTO app.${table} (tenant_id, ${cols.join(', ')})
                     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING ${idCol}`,
                    [req.auth.tenantId, ...cols.map((c) => parsed.values[c])]
                );
                return result.rows[0];
            });
            return res.status(201).json(row);
        } catch (error) {
            return handleRouteError(error, res);
        }
    });

    router.put(`${path}/:id`, requireJwt, requirePermission(ruta, 'update'), async (req, res) => {
        const id = parseId(req.params.id);
        const parsed = parse(req.body);
        if (!id || parsed.error) return res.status(400).json({ error: parsed.error || 'Valid id is required' });
        const cols = Object.keys(parsed.values);
        try {
            const row = await withTenantTransaction(req.auth, async (client) => {
                const result = await client.query(
                    `UPDATE app.${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
                     WHERE ${idCol} = $${cols.length + 1} RETURNING ${idCol}`,
                    [...cols.map((c) => parsed.values[c]), id]
                );
                return result.rows[0];
            });
            if (!row) return res.status(404).json({ error: 'Record not found in this tenant' });
            return res.json(row);
        } catch (error) {
            return handleRouteError(error, res);
        }
    });

    router.delete(`${path}/:id`, requireJwt, requirePermission(ruta, 'delete'), async (req, res) => {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Valid id is required' });
        try {
            const deleted = await withTenantTransaction(req.auth, async (client) => {
                const result = await client.query(`DELETE FROM app.${table} WHERE ${idCol} = $1 RETURNING ${idCol}`, [id]);
                return result.rows[0];
            });
            if (!deleted) return res.status(404).json({ error: 'Record not found in this tenant' });
            return res.status(204).send();
        } catch (error) {
            return handleRouteError(error, res);
        }
    });
}

// permiso: /catalog read | create | update | delete
registerCrud({
    path: '/catalog', ruta: '/catalog', table: 'productos', idCol: 'producto_id',
    listSql: `
        SELECT p.producto_id, p.nombre, p.precio, p.costo, p.stock, p.referencia_almacen,
               p.categoria_id, p.proveedor_id, p.unidad_id,
               c.nombre AS categoria, pr.nombre AS proveedor, u.abreviacion AS unidad
        FROM app.productos p
        LEFT JOIN app.categorias c ON c.tenant_id = p.tenant_id AND c.categoria_id = p.categoria_id
        LEFT JOIN app.proveedores pr ON pr.tenant_id = p.tenant_id AND pr.proveedor_id = p.proveedor_id
        LEFT JOIN app.unidades_medida u ON u.unidad_id = p.unidad_id
        ORDER BY p.producto_id`,
    parse: (b) => collect({
        nombre: nameField(b.nombre, 'Name', 100),
        precio: parseNumber(b.precio, 'Price'),
        costo: parseNumber(b.costo ?? 0, 'Cost'),
        stock: parseNumber(b.stock ?? 0, 'Stock', { max: 2147483647, integer: true }),
        referencia_almacen: optionalText(b.referencia_almacen, 'Reference', 45),
        categoria_id: idOrNull(b.categoria_id),
        proveedor_id: idOrNull(b.proveedor_id),
        unidad_id: idOrNull(b.unidad_id),
    }),
});

// permiso: /clientes read | create | update | delete
registerCrud({
    path: '/clientes', ruta: '/clientes', table: 'clientes', idCol: 'cliente_id',
    listSql: 'SELECT cliente_id, nombre_completo, telefono FROM app.clientes ORDER BY cliente_id',
    parse: (b) => collect({ nombre_completo: nameField(b.nombre_completo, 'Name', 100), telefono: parsePhone(b.telefono) }),
});

// permiso: /proveedores read | create | update | delete
registerCrud({
    path: '/proveedores', ruta: '/proveedores', table: 'proveedores', idCol: 'proveedor_id',
    listSql: 'SELECT proveedor_id, nombre, telefono FROM app.proveedores ORDER BY proveedor_id',
    parse: (b) => collect({ nombre: nameField(b.nombre, 'Name', 100), telefono: parsePhone(b.telefono) }),
});

// permiso: /categorias read | create | update | delete
registerCrud({
    path: '/categorias', ruta: '/categorias', table: 'categorias', idCol: 'categoria_id',
    listSql: 'SELECT categoria_id, nombre FROM app.categorias ORDER BY nombre',
    parse: (b) => collect({ nombre: nameField(b.nombre, 'Name', 45) }),
});

// Listas para los selectores del formulario de catalogo
// permiso: /catalog read
router.get('/catalog/lookups', requireJwt, requirePermission('/catalog', 'read'), async (req, res) => {
    try {
        const data = await withTenantTransaction(req.auth, async (client) => ({
            categorias: (await client.query('SELECT categoria_id AS id, nombre FROM app.categorias ORDER BY nombre')).rows,
            proveedores: (await client.query('SELECT proveedor_id AS id, nombre FROM app.proveedores ORDER BY nombre')).rows,
            unidades: (await client.query("SELECT unidad_id AS id, nombre || ' (' || abreviacion || ')' AS nombre FROM app.unidades_medida ORDER BY unidad_id")).rows,
        }));
        return res.json(data);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

module.exports = router;
