const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { withTenantTransaction } = require('./db');

const router = express.Router();
const jwtSecret = process.env.JWT_SECRET;
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '2h';

function requireJwt(req, res, next) {
    const authorization = req.get('authorization') || '';
    const [scheme, token] = authorization.split(' ');

    if (scheme !== 'Bearer' || !token || !jwtSecret) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        req.auth = jwt.verify(token, jwtSecret);
        if (!req.auth.userId || !req.auth.tenantId || !req.auth.perfilId) {
            return res.status(401).json({ error: 'Invalid authentication claims' });
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
                SELECT u.usuario_id, u.tenant_id, u.perfil_id, u.username, u.password_hash, p.nombre AS perfil
                FROM app.usuarios u
                JOIN app.perfiles p ON p.perfil_id = u.perfil_id
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

        console.log('🔑 LOGIN JWT SIGNING:', { userId: user.usuario_id, tenantId: user.tenant_id, perfilId: user.perfil_id });
        const token = jwt.sign({
            userId: user.usuario_id,
            tenantId: user.tenant_id,
            perfilId: user.perfil_id,
        }, jwtSecret, { expiresIn: jwtExpiresIn });

        return res.json({
            message: 'Login successful',
            token,
            user: { id: user.usuario_id, username: user.username, perfilId: user.perfil_id, perfil: user.perfil },
        });
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// MENU (arbol de nodos visible para el perfil)
// ==========================================
// Una hoja se ve si el perfil tiene fila en permisos; un contenedor se ve si alguno de sus descendientes se ve.
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
// CATALOGO (productos)
// ==========================================
router.get('/catalog', requireJwt, requirePermission('/catalog', 'read'), async (req, res) => {
    try {
        const products = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query('SELECT producto_id, nombre, precio, stock FROM app.productos ORDER BY producto_id');
            return result.rows;
        });
        return res.json(products);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

function parseProducto(body) {
    const nameError = validateText(body.nombre, 'Name', 100);
    if (nameError) {
        return { error: nameError };
    }
    const emptyPrice = body.precio === null || body.precio === undefined || body.precio === '';
    const precio = Number(body.precio);
    if (emptyPrice || !Number.isFinite(precio) || precio < 0 || precio > 99999999.99) {
        return { error: 'Price must be a number between 0 and 99999999.99' };
    }
    const emptyStock = body.stock === null || body.stock === undefined || body.stock === '';
    const stock = Number(body.stock);
    if (emptyStock || !Number.isInteger(stock) || stock < 0 || stock > 2147483647) {
        return { error: 'Stock must be a whole number of 0 or more' };
    }
    return { producto: { nombre: body.nombre.trim(), precio: Math.round(precio * 100) / 100, stock } };
}

router.post('/catalog', requireJwt, requirePermission('/catalog', 'create'), async (req, res) => {
    const parsed = parseProducto(req.body);
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error });
    }

    try {
        const product = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                INSERT INTO app.productos (tenant_id, nombre, precio, stock)
                VALUES ($1, $2, $3, $4)
                RETURNING producto_id, nombre, precio, stock
            `, [req.auth.tenantId, parsed.producto.nombre, parsed.producto.precio, parsed.producto.stock]);
            return result.rows[0];
        });
        return res.status(201).json(product);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.put('/catalog/:id', requireJwt, requirePermission('/catalog', 'update'), async (req, res) => {
    const productId = parseId(req.params.id);
    const parsed = parseProducto(req.body);
    if (!productId || parsed.error) {
        return res.status(400).json({ error: parsed.error || 'Valid product id is required' });
    }

    try {
        const product = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                UPDATE app.productos SET nombre = $1, precio = $2, stock = $3
                WHERE producto_id = $4
                RETURNING producto_id, nombre, precio, stock
            `, [parsed.producto.nombre, parsed.producto.precio, parsed.producto.stock, productId]);
            return result.rows[0];
        });
        if (!product) {
            return res.status(404).json({ error: 'Product not found in this tenant' });
        }
        return res.json(product);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.delete('/catalog/:id', requireJwt, requirePermission('/catalog', 'delete'), async (req, res) => {
    const productId = parseId(req.params.id);
    if (!productId) {
        return res.status(400).json({ error: 'Valid product id is required' });
    }

    try {
        const deleted = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query('DELETE FROM app.productos WHERE producto_id = $1 RETURNING producto_id', [productId]);
            return result.rows[0];
        });
        if (!deleted) {
            return res.status(404).json({ error: 'Product not found in this tenant' });
        }
        return res.status(204).send();
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

// ==========================================
// USUARIOS
// ==========================================
router.get('/users', requireJwt, requirePermission('/users', 'read'), async (req, res) => {
    try {
        const users = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT u.usuario_id, u.username, u.perfil_id, p.nombre AS perfil, u.is_active
                FROM app.usuarios u
                JOIN app.perfiles p ON p.perfil_id = u.perfil_id
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
// PERFILES (roles de la tienda)
// ==========================================
// La lista tambien la necesita la pantalla de usuarios para elegir el perfil.
router.get('/perfiles', requireJwt, requirePermission(['/perfiles', '/users'], 'read'), async (req, res) => {
    try {
        const perfiles = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query('SELECT perfil_id, nombre, descripcion FROM app.perfiles ORDER BY perfil_id');
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
    const description = typeof body.descripcion === 'string' ? body.descripcion.trim() : '';
    if (description.length > 200) {
        return { error: 'Description must be at most 200 characters' };
    }
    return { perfil: { nombre: body.nombre.trim(), descripcion: description || null } };
}

router.post('/perfiles', requireJwt, requirePermission('/perfiles', 'create'), async (req, res) => {
    const parsed = parsePerfil(req.body);
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error });
    }

    try {
        const perfil = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                INSERT INTO app.perfiles (tenant_id, nombre, descripcion)
                VALUES ($1, $2, $3)
                RETURNING perfil_id, nombre, descripcion
            `, [req.auth.tenantId, parsed.perfil.nombre, parsed.perfil.descripcion]);
            return result.rows[0];
        });
        return res.status(201).json(perfil);
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
        const perfil = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                UPDATE app.perfiles SET nombre = $1, descripcion = $2
                WHERE perfil_id = $3
                RETURNING perfil_id, nombre, descripcion
            `, [parsed.perfil.nombre, parsed.perfil.descripcion, perfilId]);
            return result.rows[0];
        });
        if (!perfil) {
            return res.status(404).json({ error: 'Profile not found in this tenant' });
        }
        return res.json(perfil);
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
            const perfiles = await client.query('SELECT perfil_id, nombre FROM app.perfiles ORDER BY perfil_id');
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
