// ============================================================================
// AUTENTICACION Y MENU                                   Fuente: PostgreSQL + Redis
// ----------------------------------------------------------------------------
//   POST /api/login    publico            valida usuario/clave, firma el JWT y crea la sesion en Redis
//   POST /api/logout   JWT                borra la sesion de Redis
//   GET  /api/menu     JWT                arbol de pantallas (modulos) que el perfil puede ver
// ============================================================================
const express = require('express');
const bcrypt = require('bcrypt');
const { withTenantTransaction } = require('../../config/postgres');
const { jwtConfigurado, firmarToken, requireJwt } = require('../../middleware/auth');
const { crearSesion, cerrarSesion } = require('../../services/sesiones');
const { validateText } = require('../../utils/validators');
const { handleRouteError } = require('../../utils/errors');

const router = express.Router();

// ------------------------------------------------------------------ LOGIN
router.post('/login', async (req, res) => {
    const { tenant_id: tenantId, username, password } = req.body;
    const tenantNumber = Number(tenantId);
    const usernameError = validateText(username, 'Username', 50);

    if (!Number.isInteger(tenantNumber) || tenantNumber < 1 || usernameError || typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: usernameError || 'Valid tenant, username and password are required' });
    }
    if (!jwtConfigurado()) {
        return res.status(500).json({ error: 'JWT_SECRET is not configured', details: 'JWT_SECRET is not configured' });
    }

    try {
        // 1) Usuario + perfil + rol del negocio (perfilId 0: todavia no hay sesion, solo se puede leer)
        const user = await withTenantTransaction({ tenantId: tenantNumber, perfilId: 0 }, async (client) => {
            const result = await client.query(`
                SELECT u.usuario_id, u.tenant_id, u.perfil_id, u.username, u.password_hash,
                       p.nombre AS perfil, r.nombre AS rol
                FROM app.usuarios u
                JOIN app.perfiles p ON p.perfil_id = u.perfil_id
                JOIN app.roles r ON r.rol_id = p.rol_id
                WHERE u.tenant_id = $1 AND u.username = $2 AND u.is_active = true
            `, [tenantNumber, username.trim()]);

            if (result.rows.length === 0) {
                return null;
            }
            const candidate = result.rows[0];
            return await bcrypt.compare(password, candidate.password_hash) ? candidate : null;
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials or tenant' });
        }

        // 2) JWT (usuario, negocio, perfil, jti) + sesion efimera en Redis
        const { token, jti } = firmarToken({
            userId: user.usuario_id,
            tenantId: user.tenant_id,
            perfilId: user.perfil_id,
            username: user.username,
        });
        await crearSesion(user.tenant_id, jti, password);

        return res.json({
            message: 'Login successful',
            token,
            user: { id: user.usuario_id, username: user.username, perfilId: user.perfil_id, perfil: user.perfil, rol: user.rol },
        });
    } catch (error) {
        return handleRouteError(error, res);
    }
});

// ------------------------------------------------------------------ MENU
// permiso: solo JWT (cada perfil ve unicamente las pantallas que tiene asignadas)
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

        // Una hoja asignada hace visibles a todos sus contenedores ancestros
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
        return handleRouteError(error, res);
    }
});

// ------------------------------------------------------------------ LOGOUT
// permiso: solo JWT (borra la sesion de Redis: el token deja de servir aunque no haya expirado)
router.post('/logout', requireJwt, async (req, res) => {
    try {
        await cerrarSesion(req.auth.tenantId, req.auth.jti);
        return res.status(204).send();
    } catch (error) {
        return handleRouteError(error, res);
    }
});

module.exports = router;
