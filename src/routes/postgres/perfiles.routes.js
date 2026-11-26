// ============================================================================
// PERFILES Y ROLES                                       Fuente: PostgreSQL (RLS)
// ----------------------------------------------------------------------------
// - ROL    (app.roles)    : catalogo global (Administrador, Gerente, Cajero). Define QUE DASHBOARD DE KPI ve el perfil.
// - PERFIL (app.perfiles) : pertenece a un negocio y apunta a un rol (rol_id). Define QUE PANTALLAS ve (tabla permisos).
//
//   GET    /api/roles         permiso: /perfiles o /users read    (catalogo para el selector de rol)
//   GET    /api/perfiles      permiso: /perfiles o /users read    (la pantalla de usuarios tambien la necesita)
//   POST   /api/perfiles      permiso: /perfiles create
//   PUT    /api/perfiles/:id  permiso: /perfiles update
//   DELETE /api/perfiles/:id  permiso: /perfiles delete
// ============================================================================
const express = require('express');
const { withTenantTransaction } = require('../../config/postgres');
const { requireJwt } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permisos');
const { validateText, parseId } = require('../../utils/validators');
const { handleRouteError } = require('../../utils/errors');

const router = express.Router();

function parsePerfil(body) {
    const nameError = validateText(body.nombre, 'Name', 50);
    if (nameError) {
        return { error: nameError };
    }
    const rolId = parseId(body.rol_id);
    if (!rolId) {
        return { error: 'Role is required' };
    }
    const description = typeof body.descripcion === 'string' ? body.descripcion.trim() : '';
    if (description.length > 200) {
        return { error: 'Description must be at most 200 characters' };
    }
    return { perfil: { nombre: body.nombre.trim(), descripcion: description || null, rolId } };
}

// permiso: /perfiles o /users read
router.get('/roles', requireJwt, requirePermission(['/perfiles', '/users'], 'read'), async (req, res) => {
    try {
        const roles = await withTenantTransaction(req.auth, async (client) =>
            (await client.query('SELECT rol_id, nombre, descripcion FROM app.roles ORDER BY rol_id')).rows);
        return res.json(roles);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// permiso: /perfiles o /users read
router.get('/perfiles', requireJwt, requirePermission(['/perfiles', '/users'], 'read'), async (req, res) => {
    try {
        const perfiles = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT p.perfil_id, p.nombre, p.descripcion, p.rol_id, r.nombre AS rol
                FROM app.perfiles p
                JOIN app.roles r ON r.rol_id = p.rol_id
                ORDER BY p.perfil_id
            `);
            return result.rows;
        });
        return res.json(perfiles);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// permiso: /perfiles create
router.post('/perfiles', requireJwt, requirePermission('/perfiles', 'create'), async (req, res) => {
    const parsed = parsePerfil(req.body);
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error });
    }

    try {
        const result = await withTenantTransaction(req.auth, async (client) => {
            const roleCheck = await client.query('SELECT nombre FROM app.roles WHERE rol_id = $1', [parsed.perfil.rolId]);
            if (roleCheck.rows.length === 0) {
                return { error: 'Selected role does not exist' };
            }
            const inserted = await client.query(`
                INSERT INTO app.perfiles (tenant_id, nombre, descripcion, rol_id)
                VALUES ($1, $2, $3, $4)
                RETURNING perfil_id, nombre, descripcion, rol_id
            `, [req.auth.tenantId, parsed.perfil.nombre, parsed.perfil.descripcion, parsed.perfil.rolId]);
            return { row: { ...inserted.rows[0], rol: roleCheck.rows[0].nombre } };
        });
        if (result.error) {
            return res.status(400).json({ error: result.error });
        }
        return res.status(201).json(result.row);
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// permiso: /perfiles update
router.put('/perfiles/:id', requireJwt, requirePermission('/perfiles', 'update'), async (req, res) => {
    const perfilId = parseId(req.params.id);
    const parsed = parsePerfil(req.body);
    if (!perfilId || parsed.error) {
        return res.status(400).json({ error: parsed.error || 'Valid profile id is required' });
    }

    try {
        const result = await withTenantTransaction(req.auth, async (client) => {
            const roleCheck = await client.query('SELECT nombre FROM app.roles WHERE rol_id = $1', [parsed.perfil.rolId]);
            if (roleCheck.rows.length === 0) {
                return { error: 'Selected role does not exist' };
            }
            const updated = await client.query(`
                UPDATE app.perfiles
                SET nombre = $1, descripcion = $2, rol_id = $3
                WHERE perfil_id = $4
                RETURNING perfil_id, nombre, descripcion, rol_id
            `, [parsed.perfil.nombre, parsed.perfil.descripcion, parsed.perfil.rolId, perfilId]);
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
        return handleRouteError(error, res);
    }
});

// permiso: /perfiles delete
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
        return handleRouteError(error, res);
    }
});

module.exports = router;
