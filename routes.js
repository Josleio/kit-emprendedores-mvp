const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { withTenantTransaction } = require('./db');
const { redisClient } = require('./cliente_redis');
const { getMongo } = require('./mongo');
const { runEtl } = require('./etl');
const { KPIS, catalogoPublico } = require('./kpis');

const router = express.Router();
const jwtSecret = process.env.JWT_SECRET;
const SESSION_TTL = 7200; // segundos: duracion del JWT y de la sesion en Redis

async function requireJwt(req, res, next) {
    const authorization = req.get('authorization') || '';
    const [scheme, token] = authorization.split(' ');

    if (scheme !== 'Bearer' || !token || !jwtSecret) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        req.auth = jwt.verify(token, jwtSecret);
        if (!req.auth.userId || !req.auth.tenantId || !req.auth.perfilId || !req.auth.jti) {
            return res.status(401).json({ error: 'Invalid authentication claims' });
        }
        // Sesion efimera en Redis: si el servicio esta activo, la sesion debe existir (login la crea, logout la borra)
        if (redisClient.isReady) {
            const alive = await redisClient.get(`session:${req.auth.tenantId}:${req.auth.jti}`);
            if (!alive) {
                return res.status(401).json({ error: 'Session expired or closed' });
            }
        }
        return next();
    } catch (error) {
        console.error("❌ JWT REJECTED:", error.message);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function validateText(value, field, maxLength) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
        return `${field} is required and must be at most ${maxLength} characters`;
    }
    return null;
}

function parseId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function isRlsViolation(error) {
    return error && (error.code === '42501' || error.code === '23514');
}

function handleRouteError(error, res) {
    if (isRlsViolation(error)) {
        return res.status(403).json({ error: 'Operation not permitted by database policy' });
    }
    if (error.code === '23505') {
        return res.status(409).json({ error: 'A record with the same name or route already exists in this tenant' });
    }
    if (error.code === '23503') {
        return res.status(409).json({ error: 'The record is in use by other records or points to a missing record' });
    }
    return res.status(500).json({ error: 'Internal server error', details: error.message });
}

// Verifica contra la tabla permisos si el perfil de la sesion puede hacer <action> en alguna de las pantallas.
// action: 'read' (tiene acceso a la pantalla), 'create', 'update' o 'delete'.
function requirePermission(screens, action) {
    const routes = Array.isArray(screens) ? screens : [screens];
    return async (req, res, next) => {
        try {
            const allowed = await withTenantTransaction(req.auth, async (client) => {
                for (const ruta of routes) {
                    const result = await client.query('SELECT app.tiene_permiso($1, $2) AS ok', [ruta, action]);
                    if (result.rows[0].ok) {
                        return true;
                    }
                }
                return false;
            });
            if (!allowed) {
                return res.status(403).json({ error: 'Your profile is not allowed to perform this action' });
            }
            return next();
        } catch (error) {
            console.error("❌ BACKEND ERROR:", error.stack);
            return handleRouteError(error, res);
        }
    };
}

// ==========================================
// AUTENTICACION
// ==========================================
router.post('/login', async (req, res) => {
    const { tenant_id: tenantId, username, password } = req.body;
    const { password: ignoredPassword, ...safeBody } = req.body;
    console.log('📥 LOGIN REQUEST:', safeBody);
    const tenantNumber = Number(tenantId);
    const usernameError = validateText(username, 'Username', 50);

    if (!Number.isInteger(tenantNumber) || tenantNumber < 1 || usernameError || typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: usernameError || 'Valid tenant, username and password are required' });
    }
    if (!jwtSecret) {
        return res.status(500).json({ error: 'JWT_SECRET is not configured', details: 'JWT_SECRET is not configured' });
    }

    try {
        const user = await withTenantTransaction({ tenantId: tenantNumber, perfilId: 0 }, async (client) => {
            console.log('🔎 LOGIN DB QUERY:', { tenantId: tenantNumber, username: username.trim() });
            const result = await client.query(`
                SELECT u.usuario_id, u.tenant_id, u.perfil_id, u.username, u.password_hash,
                       p.nombre AS perfil, p.rol_id, r.nombre AS rol
                FROM app.usuarios u
                JOIN app.perfiles p ON p.perfil_id = u.perfil_id
                LEFT JOIN app.roles r ON r.rol_id = p.rol_id
                WHERE u.tenant_id = $1 AND u.username = $2 AND u.is_active = true
            `, [tenantNumber, username.trim()]);

            if (result.rows.length === 0) {
                return null;
            }

            const candidate = result.rows[0];
            const passwordMatches = await bcrypt.compare(password, candidate.password_hash);
            console.log('🔐 LOGIN BCRYPT CHECK:', { username: candidate.username, passwordMatches });
            return passwordMatches ? candidate : null;
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials or tenant' });
        }

        console.log('🔑 LOGIN JWT SIGNING:', { userId: user.usuario_id, tenantId: user.tenant_id, perfilId: user.perfil_id, rolId: user.rol_id });
        const jti = crypto.randomUUID();
        const token = jwt.sign({
            userId: user.usuario_id,
            tenantId: user.tenant_id,
            perfilId: user.perfil_id,
            jti,
        }, jwtSecret, { expiresIn: SESSION_TTL });

        if (redisClient.isReady) {
            await redisClient.set(`session:${user.tenant_id}:${jti}`, String(user.usuario_id), { EX: SESSION_TTL });
        }

        return res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.usuario_id,
                username: user.username,
                perfilId: user.perfil_id,
                perfil: user.perfil,
                rolId: user.rol_id,
                rol: user.rol,
            },
        });
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// MENU (arbol de nodos visible para el perfil)
// ==========================================
router.get('/menu', requireJwt, async (req, res) => {
    try {
        const rows = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT m.modulo_id, m.nombre, m.ruta, m.padre_id, m.orden, m.es_nodo,
                       (p.perfil_id IS NOT NULL) AS asignado,
                       COALESCE(p.can_create, false) AS can_create,
                       COALESCE(p.can_update, false) AS can_update,
                       COALESCE(p.can_delete, false) AS can_delete
                FROM app.modulos m
                LEFT JOIN app.permisos p ON p.modulo_id = m.modulo_id AND p.perfil_id = $1
                ORDER BY m.orden, m.modulo_id
            `, [req.auth.perfilId]);
            return result.rows;
        });

        const byId = new Map(rows.map((row) => [row.modulo_id, row]));
        const visible = new Set();
        rows.filter((row) => !row.es_nodo && row.asignado).forEach((leaf) => {
            let current = leaf;
            let guard = 0;
            while (current && !visible.has(current.modulo_id) && guard < 100) {
                visible.add(current.modulo_id);
                current = current.padre_id ? byId.get(current.padre_id) : null;
                guard += 1;
            }
        });

        const menu = rows
            .filter((row) => visible.has(row.modulo_id))
            .map(({ asignado, ...module }) => module);
        return res.json(menu);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// SESION
// ==========================================
router.post('/logout', requireJwt, async (req, res) => {
    if (redisClient.isReady) {
        await redisClient.del(`session:${req.auth.tenantId}:${req.auth.jti}`);
    }
    return res.status(204).send();
});

// ==========================================
// CRUD GENERICO (catalogo, clientes, proveedores, categorias)
// ==========================================
function idOrNull(value) {
    if (value === null || value === undefined || value === '') return { value: null };
    const id = parseId(value);
    return id ? { value: id } : { error: 'Invalid reference' };
}

function optionalText(value, field, max) {
    if (value === null || value === undefined || value === '') return { value: null };
    if (typeof value !== 'string' || value.length > max) return { error: `${field} must be at most ${max} characters` };
    return { value: value.trim() };
}

function parsePhone(value) {
    const text = optionalText(value, 'Phone', 20);
    if (text.error || text.value === null) return text;
    return /^[0-9+()\s-]+$/.test(text.value) ? text : { error: 'Phone can only contain digits, spaces, +, - and parentheses' };
}

function parseNumber(value, field, { min = 0, max = 99999999.99, integer = false } = {}) {
    if (value === null || value === undefined || value === '') return { error: `${field} is required` };
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
        return { error: `${field} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}` };
    }
    return { value: integer ? number : Math.round(number * 100) / 100 };
}

function collect(parts) {
    const values = {};
    for (const [key, result] of Object.entries(parts)) {
        if (result.error) return { error: result.error };
        values[key] = result.value;
    }
    return { values };
}

function nameField(value, field, max) {
    const error = validateText(value, field, max);
    return error ? { error } : { value: value.trim() };
}

function registerCrud({ path, ruta, table, idCol, listSql, parse }) {
    router.get(path, requireJwt, requirePermission(ruta, 'read'), async (req, res) => {
        try {
            const rows = await withTenantTransaction(req.auth, async (client) => (await client.query(listSql)).rows);
            return res.json(rows);
        } catch (error) {
            console.error("❌ BACKEND ERROR:", error.stack);
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
            console.error("❌ BACKEND ERROR:", error.stack);
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
            console.error("❌ BACKEND ERROR:", error.stack);
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
            console.error("❌ BACKEND ERROR:", error.stack);
            return handleRouteError(error, res);
        }
    });
}

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

registerCrud({
    path: '/clientes', ruta: '/clientes', table: 'clientes', idCol: 'cliente_id',
    listSql: 'SELECT cliente_id, nombre_completo, telefono FROM app.clientes ORDER BY cliente_id',
    parse: (b) => collect({ nombre_completo: nameField(b.nombre_completo, 'Name', 100), telefono: parsePhone(b.telefono) }),
});

registerCrud({
    path: '/proveedores', ruta: '/proveedores', table: 'proveedores', idCol: 'proveedor_id',
    listSql: 'SELECT proveedor_id, nombre, telefono FROM app.proveedores ORDER BY proveedor_id',
    parse: (b) => collect({ nombre: nameField(b.nombre, 'Name', 100), telefono: parsePhone(b.telefono) }),
});

registerCrud({
    path: '/categorias', ruta: '/categorias', table: 'categorias', idCol: 'categoria_id',
    listSql: 'SELECT categoria_id, nombre FROM app.categorias ORDER BY nombre',
    parse: (b) => collect({ nombre: nameField(b.nombre, 'Name', 45) }),
});

// Listas para los selectores del formulario de catalogo
router.get('/catalog/lookups', requireJwt, requirePermission('/catalog', 'read'), async (req, res) => {
    try {
        const data = await withTenantTransaction(req.auth, async (client) => ({
            categorias: (await client.query('SELECT categoria_id AS id, nombre FROM app.categorias ORDER BY nombre')).rows,
            proveedores: (await client.query('SELECT proveedor_id AS id, nombre FROM app.proveedores ORDER BY nombre')).rows,
            unidades: (await client.query("SELECT unidad_id AS id, nombre || ' (' || abreviacion || ')' AS nombre FROM app.unidades_medida ORDER BY unidad_id")).rows,
        }));
        return res.json(data);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// VENTAS (registro inmutable: se crea, se consulta y solo se puede anular)
// ==========================================
router.get('/ventas/lookups', requireJwt, requirePermission('/ventas', 'read'), async (req, res) => {
    try {
        const data = await withTenantTransaction(req.auth, async (client) => ({
            clientes: (await client.query('SELECT cliente_id, nombre_completo FROM app.clientes ORDER BY nombre_completo')).rows,
            productos: (await client.query('SELECT producto_id, nombre, precio, stock FROM app.productos WHERE stock > 0 ORDER BY nombre')).rows,
            metodos: (await client.query('SELECT metodo_pago_id, nombre FROM app.metodos_pago ORDER BY metodo_pago_id')).rows,
        }));
        return res.json(data);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

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
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

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
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// Registrar una venta: todo en una transaccion (venta + items + pago + descuento de stock) o nada.
router.post('/ventas', requireJwt, requirePermission('/ventas', 'create'), async (req, res) => {
    const cliente = idOrNull(req.body.cliente_id);
    const metodoId = parseId(req.body.metodo_pago_id);
    const items = req.body.items;
    if (cliente.error || !metodoId || !Array.isArray(items) || items.length === 0 || items.length > 100) {
        return res.status(400).json({ error: 'Payment method and at least one item are required' });
    }

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
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// Anular: la venta no se borra, cambia de estado y el stock vuelve al inventario.
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
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// ANALITICA: KPI por rol (resultados calculados por el ETL y guardados en MongoDB)
// ==========================================
async function mongoOr503(res) {
    try {
        return await getMongo();
    } catch (error) {
        res.status(503).json({ error: 'MongoDB is not available. Check that the MongoDB service is running.' });
        return null;
    }
}

// Dashboard del rol funcional del usuario (el Administrador puede consultar cualquier rol con ?rol=)
router.get('/analitica/kpis', requireJwt, requirePermission('/analitica', 'read'), async (req, res) => {
    const db = await mongoOr503(res);
    if (!db) return undefined;
    try {
        const { info, rolesDisponibles } = await withTenantTransaction(req.auth, async (client) => {
            const perfilRes = await client.query(`
                SELECT p.nombre AS perfil, r.nombre AS rol
                FROM app.perfiles p
                LEFT JOIN app.roles r ON r.rol_id = p.rol_id
                WHERE p.perfil_id = $1
            `, [req.auth.perfilId]);
            const rolesRes = await client.query('SELECT nombre FROM app.roles ORDER BY rol_id');
            return {
                info: perfilRes.rows[0] || {},
                rolesDisponibles: rolesRes.rows.map((row) => row.nombre),
            };
        });

        const perfil = info.perfil || null;
        const rolBase = info.rol || null;
        const rol = rolBase === 'Administrador' && rolesDisponibles.includes(req.query.rol)
            ? req.query.rol
            : rolBase;

        if (!rol || !rolesDisponibles.includes(rol)) {
            return res.json({
                rol: rolBase,
                perfil,
                roles_disponibles: [],
                kpis_del_rol: 0,
                resultados: [],
                sin_rol: true,
            });
        }

        const codigos = KPIS.filter((k) => k.roles.includes(rol)).map((k) => k.codigo);
        const resultados = await db.collection('kpi_resultados')
            .find({ tenant_id: req.auth.tenantId, codigo: { $in: codigos } }, { projection: { _id: 0 } })
            .sort({ codigo: 1 })
            .toArray();

        return res.json({
            rol,
            perfil,
            kpis_del_rol: codigos.length,
            resultados,
            roles_disponibles: rolBase === 'Administrador' ? rolesDisponibles : [rol],
        });
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return res.status(500).json({ error: 'Could not read analytics data', details: error.message });
    }
});

// Tabla documentada de KPI (la misma que se guarda en MongoDB, coleccion kpi_catalogo)
router.get('/analitica/catalogo', requireJwt, requirePermission('/analitica', 'read'), (req, res) => res.json(catalogoPublico()));

// Proceso ETL de la ultima corrida: un paso por operador de KPI + el resultado que quedo en MongoDB
router.get('/analitica/etl-log', requireJwt, requirePermission('/analitica', 'update'), async (req, res) => {
    const db = await mongoOr503(res);
    if (!db) return undefined;
    try {
        const pasos = await db.collection('etl_log').find({ tenant_id: req.auth.tenantId }, { projection: { _id: 0 } }).sort({ orden: 1 }).toArray();
        const docs = await db.collection('kpi_resultados').find({ tenant_id: req.auth.tenantId }, { projection: { _id: 0 } }).toArray();
        return res.json({ pasos, documentos: Object.fromEntries(docs.map((d) => [d.codigo, d])) });
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return res.status(500).json({ error: 'Could not read the ETL log', details: error.message });
    }
});

// Boton "Refresh data": ejecuta el ETL de este negocio (PostgreSQL -> MongoDB)
router.post('/analitica/etl', requireJwt, requirePermission('/analitica', 'update'), async (req, res) => {
    if (!await mongoOr503(res)) return undefined;
    try {
        return res.json(await runEtl(req.auth.tenantId));
    } catch (error) {
        console.error("❌ ETL ERROR:", error.stack);
        return res.status(500).json({ error: 'ETL failed', details: error.message });
    }
});

// ==========================================
// INTEGRACION: estado de PostgreSQL + Redis + MongoDB
// ==========================================
router.get('/integracion/estado', requireJwt, requirePermission('/integracion', 'read'), async (req, res) => {
    const estado = { postgres: { conectado: false }, redis: { conectado: false }, mongo: { conectado: false } };

    try {
        const t0 = Date.now();
        estado.postgres = await withTenantTransaction(req.auth, async (client) => {
            const info = (await client.query(`
                SELECT version() AS version, current_database() AS base,
                       (SELECT count(*) FROM app.productos)::int AS productos,
                       (SELECT count(*) FROM app.clientes)::int AS clientes,
                       (SELECT count(*) FROM app.ventas)::int AS ventas,
                       (SELECT count(*) FROM app.usuarios)::int AS usuarios`)).rows[0];
            return {
                conectado: true,
                ms: Date.now() - t0,
                version: info.version.split(' ').slice(0, 2).join(' '),
                base: info.base,
                funcion: 'Datos transaccionales, RBAC y aislamiento por negocio (RLS)',
                tablas: { productos: info.productos, clientes: info.clientes, ventas: info.ventas, usuarios: info.usuarios },
            };
        });
    } catch (error) {
        estado.postgres = { conectado: false, error: error.message };
    }

    try {
        if (redisClient.isReady) {
            const t0 = Date.now();
            await redisClient.ping();
            let sesiones = 0;
            for await (const batch of redisClient.scanIterator({ MATCH: `session:${req.auth.tenantId}:*`, COUNT: 100 })) {
                sesiones += Array.isArray(batch) ? batch.length : 1;
            }
            const ttl = await redisClient.ttl(`session:${req.auth.tenantId}:${req.auth.jti}`);
            estado.redis = {
                conectado: true,
                ms: Date.now() - t0,
                funcion: 'Sesiones efimeras con expiracion automatica',
                sesiones_activas: sesiones,
                ttl_sesion_actual_seg: ttl,
            };
        } else {
            estado.redis = { conectado: false, error: 'Redis is not running: sessions rely only on the JWT.' };
        }
    } catch (error) {
        estado.redis = { conectado: false, error: error.message };
    }

    try {
        const t0 = Date.now();
        const db = await getMongo();
        const colecciones = {};
        for (const name of ['kpi_resultados', 'etl_log', 'catalogo_productos', 'ventas_resumen']) {
            colecciones[name] = await db.collection(name).countDocuments({ tenant_id: req.auth.tenantId });
        }
        colecciones.kpi_catalogo = await db.collection('kpi_catalogo').countDocuments();
        const last = await db.collection('kpi_resultados').find({ tenant_id: req.auth.tenantId }).sort({ generado_en: -1 }).limit(1).toArray();
        estado.mongo = {
            conectado: true,
            ms: Date.now() - t0,
            base: db.databaseName,
            funcion: 'Resultados de KPI y documentos analiticos (ETL)',
            colecciones,
            ultimo_etl: last[0] ? last[0].generado_en : null,
        };
    } catch (error) {
        estado.mongo = { conectado: false, error: 'MongoDB is not available.' };
    }

    return res.json(estado);
});

// ==========================================
// USUARIOS
// ==========================================
router.get('/users', requireJwt, requirePermission('/users', 'read'), async (req, res) => {
    try {
        const users = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT u.usuario_id, u.username, u.perfil_id, p.nombre AS perfil, p.rol_id, r.nombre AS rol, u.is_active
                FROM app.usuarios u
                JOIN app.perfiles p ON p.perfil_id = u.perfil_id
                LEFT JOIN app.roles r ON r.rol_id = p.rol_id
                ORDER BY u.usuario_id
            `);
            return result.rows;
        });
        return res.json(users);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.post('/users', requireJwt, requirePermission('/users', 'create'), async (req, res) => {
    const { username, password, perfil_id: perfilId } = req.body;
    const usernameError = validateText(username, 'Username', 50);
    const profileNumber = Number(perfilId);

    if (usernameError || typeof password !== 'string' || password.length < 4 || !Number.isInteger(profileNumber) || profileNumber < 1) {
        return res.status(400).json({ error: usernameError || 'Password must have at least 4 characters and profile is required' });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const user = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                INSERT INTO app.usuarios (tenant_id, perfil_id, username, password_hash, is_active)
                VALUES ($1, $2, $3, $4, true)
                RETURNING usuario_id, username, perfil_id, is_active
            `, [req.auth.tenantId, profileNumber, username.trim(), passwordHash]);
            return result.rows[0];
        });
        return res.status(201).json(user);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.put('/users/:id', requireJwt, requirePermission('/users', 'update'), async (req, res) => {
    const userId = Number(req.params.id);
    const { username, password, perfil_id: perfilId, is_active: isActive } = req.body;
    const usernameError = validateText(username, 'Username', 50);
    const profileNumber = Number(perfilId);

    if (!Number.isInteger(userId) || userId < 1 || usernameError || !Number.isInteger(profileNumber) || profileNumber < 1 || typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'Valid user id, username, profile and active state are required' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 4)) {
        return res.status(400).json({ error: 'Password must have at least 4 characters when provided' });
    }

    try {
        const user = await withTenantTransaction(req.auth, async (client) => {
            const passwordHash = password ? await bcrypt.hash(password, 12) : null;
            const result = await client.query(`
                UPDATE app.usuarios
                SET username = $1,
                    perfil_id = $2,
                    is_active = $3,
                    password_hash = COALESCE($4, password_hash)
                WHERE usuario_id = $5
                RETURNING usuario_id, username, perfil_id, is_active
            `, [username.trim(), profileNumber, isActive, passwordHash, userId]);
            return result.rows[0];
        });
        if (!user) {
            return res.status(403).json({ error: 'User is outside the current tenant or operation is not permitted' });
        }
        return res.json(user);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.delete('/users/:id', requireJwt, requirePermission('/users', 'delete'), async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId < 1) {
        return res.status(400).json({ error: 'Valid user id is required' });
    }

    try {
        const deleted = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query('DELETE FROM app.usuarios WHERE usuario_id = $1 RETURNING usuario_id', [userId]);
            return result.rows[0];
        });
        if (!deleted) {
            return res.status(403).json({ error: 'User is outside the current tenant or operation is not permitted' });
        }
        return res.status(204).send();
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// ROLES GLOBALES (catalogo funcional para perfiles y KPIs)
// ==========================================
router.get('/roles', requireJwt, requirePermission(['/perfiles', '/users', '/analitica'], 'read'), async (req, res) => {
    try {
        const roles = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query('SELECT rol_id, nombre FROM app.roles ORDER BY rol_id');
            return result.rows;
        });
        return res.json(roles);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// PERFILES (roles personalizados del tenant vinculados a app.roles)
// ==========================================
router.get('/perfiles', requireJwt, requirePermission(['/perfiles', '/users'], 'read'), async (req, res) => {
    try {
        const perfiles = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT p.perfil_id, p.nombre, p.descripcion, p.rol_id, r.nombre AS rol
                FROM app.perfiles p
                LEFT JOIN app.roles r ON r.rol_id = p.rol_id
                ORDER BY p.perfil_id
            `);
            return result.rows;
        });
        return res.json(perfiles);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

function parsePerfil(body) {
    const nameError = validateText(body.nombre, 'Name', 50);
    if (nameError) {
        return { error: nameError };
    }
    const rolId = parseId(body.rol_id);
    if (!rolId) {
        return { error: 'Valid role id (rol_id) is required' };
    }
    const description = typeof body.descripcion === 'string' ? body.descripcion.trim() : '';
    if (description.length > 200) {
        return { error: 'Description must be at most 200 characters' };
    }
    return {
        perfil: {
            nombre: body.nombre.trim(),
            descripcion: description || null,
            rol_id: rolId,
        },
    };
}

router.post('/perfiles', requireJwt, requirePermission('/perfiles', 'create'), async (req, res) => {
    const parsed = parsePerfil(req.body);
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error });
    }

    try {
        const result = await withTenantTransaction(req.auth, async (client) => {
            const roleCheck = await client.query('SELECT nombre FROM app.roles WHERE rol_id = $1', [parsed.perfil.rol_id]);
            if (roleCheck.rows.length === 0) {
                return { error: 'Selected role does not exist' };
            }
            const inserted = await client.query(`
                INSERT INTO app.perfiles (tenant_id, nombre, descripcion, rol_id)
                VALUES ($1, $2, $3, $4)
                RETURNING perfil_id, nombre, descripcion, rol_id
            `, [req.auth.tenantId, parsed.perfil.nombre, parsed.perfil.descripcion, parsed.perfil.rol_id]);
            return { row: { ...inserted.rows[0], rol: roleCheck.rows[0].nombre } };
        });
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }
        return res.status(201).json(result.row);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.put('/perfiles/:id', requireJwt, requirePermission('/perfiles', 'update'), async (req, res) => {
    const perfilId = parseId(req.params.id);
    const parsed = parsePerfil(req.body);
    if (!perfilId || parsed.error) {
        return res.status(400).json({ error: parsed.error || 'Valid profile id is required' });
    }

    try {
        const result = await withTenantTransaction(req.auth, async (client) => {
            const roleCheck = await client.query('SELECT nombre FROM app.roles WHERE rol_id = $1', [parsed.perfil.rol_id]);
            if (roleCheck.rows.length === 0) {
                return { error: 'Selected role does not exist' };
            }
            const updated = await client.query(`
                UPDATE app.perfiles
                SET nombre = $1, descripcion = $2, rol_id = $3
                WHERE perfil_id = $4
                RETURNING perfil_id, nombre, descripcion, rol_id
            `, [parsed.perfil.nombre, parsed.perfil.descripcion, parsed.perfil.rol_id, perfilId]);
            if (!updated.rows[0]) {
                return { notFound: true };
            }
            return { row: { ...updated.rows[0], rol: roleCheck.rows[0].nombre } };
        });
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }
        if (result.notFound) {
            return res.status(404).json({ error: 'Profile not found in this tenant' });
        }
        return res.json(result.row);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.delete('/perfiles/:id', requireJwt, requirePermission('/perfiles', 'delete'), async (req, res) => {
    const perfilId = parseId(req.params.id);
    if (!perfilId) {
        return res.status(400).json({ error: 'Valid profile id is required' });
    }

    try {
        const deleted = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query('DELETE FROM app.perfiles WHERE perfil_id = $1 RETURNING perfil_id', [perfilId]);
            return result.rows[0];
        });
        if (!deleted) {
            return res.status(404).json({ error: 'Profile not found in this tenant' });
        }
        return res.status(204).send();
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

const MODULE_COLUMNS = 'modulo_id, nombre, ruta, padre_id, orden, es_nodo';

// ==========================================
// PERMISOS (asignacion perfil <-> pantalla)
// ==========================================
router.get('/permisos', requireJwt, requirePermission('/permisos', 'read'), async (req, res) => {
    try {
        const data = await withTenantTransaction(req.auth, async (client) => {
            const perfiles = await client.query(`
                SELECT p.perfil_id, p.nombre, p.rol_id, r.nombre AS rol
                FROM app.perfiles p
                LEFT JOIN app.roles r ON r.rol_id = p.rol_id
                ORDER BY p.perfil_id
            `);
            const modulos = await client.query(`SELECT ${MODULE_COLUMNS} FROM app.modulos ORDER BY orden, modulo_id`);
            const permisos = await client.query('SELECT perfil_id, modulo_id, can_create, can_update, can_delete FROM app.permisos');
            return { perfiles: perfiles.rows, modulos: modulos.rows, permisos: permisos.rows };
        });
        return res.json(data);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// Guardar = crear la asignacion o actualizar sus banderas
router.put('/permisos', requireJwt, requirePermission('/permisos', 'update'), async (req, res) => {
    const perfilId = parseId(req.body.perfil_id);
    const moduloId = parseId(req.body.modulo_id);
    const flags = [req.body.can_create, req.body.can_update, req.body.can_delete];

    if (!perfilId || !moduloId || flags.some((flag) => typeof flag !== 'boolean')) {
        return res.status(400).json({ error: 'Profile, node and the three action flags are required' });
    }

    try {
        const result = await withTenantTransaction(req.auth, async (client) => {
            const target = await client.query('SELECT es_nodo FROM app.modulos WHERE modulo_id = $1', [moduloId]);
            if (target.rows.length === 0) {
                return { error: 'Node not found in this tenant' };
            }
            if (target.rows[0].es_nodo) {
                return { error: 'Permissions are assigned to screens, not to container nodes' };
            }
            const profile = await client.query('SELECT 1 FROM app.perfiles WHERE perfil_id = $1', [perfilId]);
            if (profile.rows.length === 0) {
                return { error: 'Profile not found in this tenant' };
            }
            const saved = await client.query(`
                INSERT INTO app.permisos (perfil_id, modulo_id, can_create, can_update, can_delete)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (perfil_id, modulo_id) DO UPDATE
                SET can_create = EXCLUDED.can_create,
                    can_update = EXCLUDED.can_update,
                    can_delete = EXCLUDED.can_delete
                RETURNING perfil_id, modulo_id, can_create, can_update, can_delete
            `, [perfilId, moduloId, ...flags]);
            return { row: saved.rows[0] };
        });
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }
        return res.json(result.row);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// Quitar = eliminar la asignacion (el perfil pierde el acceso a la pantalla)
router.delete('/permisos/:perfilId/:moduloId', requireJwt, requirePermission('/permisos', 'delete'), async (req, res) => {
    const perfilId = parseId(req.params.perfilId);
    const moduloId = parseId(req.params.moduloId);
    if (!perfilId || !moduloId) {
        return res.status(400).json({ error: 'Valid profile and node ids are required' });
    }

    try {
        const deleted = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(
                'DELETE FROM app.permisos WHERE perfil_id = $1 AND modulo_id = $2 RETURNING perfil_id',
                [perfilId, moduloId]
            );
            return result.rows[0];
        });
        if (!deleted) {
            return res.status(404).json({ error: 'Assignment not found' });
        }
        return res.status(204).send();
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

module.exports = router;