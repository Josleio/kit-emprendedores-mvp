// ============================================================================
// USUARIOS                                               Fuente: PostgreSQL (RLS)
// ----------------------------------------------------------------------------
//   GET    /api/users        permiso: /users read
//   POST   /api/users        permiso: /users create
//   PUT    /api/users/:id    permiso: /users update
//   DELETE /api/users/:id    permiso: /users delete
// Las contrasenas se guardan con bcrypt. El perfil asignado define lo que el usuario puede hacer.
// ============================================================================
const express = require('express');
const bcrypt = require('bcrypt');
const { withTenantTransaction } = require('../../config/postgres');
const { requireJwt } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permisos');
const { validateText } = require('../../utils/validators');
const { handleRouteError } = require('../../utils/errors');

const router = express.Router();

// permiso: /users read
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
        return handleRouteError(error, res);
    }
});

// permiso: /users create
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
        return handleRouteError(error, res);
    }
});

// permiso: /users update
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
        return handleRouteError(error, res);
    }
});

// permiso: /users delete
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
        return handleRouteError(error, res);
    }
});

module.exports = router;
