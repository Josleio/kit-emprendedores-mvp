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

function isRlsViolation(error) {
    return error && (error.code === '42501' || error.code === '23514');
}

function handleRouteError(error, res) {
    if (isRlsViolation(error)) {
        return res.status(403).json({ error: 'Operation not permitted by database policy' });
    }
    if (error.code === '23505') {
        return res.status(409).json({ error: 'Username already exists in this tenant' });
    }
    return res.status(500).json({ error: 'Internal server error', details: error.message });
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
                SELECT usuario_id, tenant_id, perfil_id, username, password_hash
                FROM app.usuarios
                WHERE tenant_id = $1 AND username = $2 AND is_active = true
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
            user: { id: user.usuario_id, username: user.username, perfilId: user.perfil_id },
        });
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.get('/menu', requireJwt, async (req, res) => {
    try {
        const menu = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query(`
                SELECT m.modulo_id, m.nombre, m.ruta,
                       p.can_create, p.can_update, p.can_delete
                FROM app.permisos p
                JOIN app.modulos m ON m.modulo_id = p.modulo_id
                WHERE p.perfil_id = $1
                ORDER BY m.modulo_id
            `, [req.auth.perfilId]);
            return result.rows;
        });
        return res.json(menu);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.get('/catalog', requireJwt, async (req, res) => {
    try {
        const products = await withTenantTransaction(req.auth, async (client) => {
            const result = await client.query('SELECT nombre, precio, stock FROM app.productos ORDER BY producto_id');
            return result.rows;
        });
        return res.json(products);
    } catch (error) {
        console.error("❌ BACKEND ERROR:", error.stack);
        return handleRouteError(error, res);
    }
});

router.get('/users', requireJwt, async (req, res) => {
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

router.post('/users', requireJwt, async (req, res) => {
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

router.put('/users/:id', requireJwt, async (req, res) => {
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

router.delete('/users/:id', requireJwt, async (req, res) => {
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

module.exports = router;