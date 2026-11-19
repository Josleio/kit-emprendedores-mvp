// ============================================================================
// AUTENTICACION: JWT + SESION EN REDIS
// ----------------------------------------------------------------------------
// firmarToken : crea el JWT del login (lleva usuario, negocio, perfil y un jti unico).
// requireJwt  : middleware de las rutas protegidas. Verifica el JWT y que la sesion
//               (session:{negocio}:{jti}) siga viva en Redis. Deja los datos en req.auth.
// ============================================================================
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { TTL_SESION, validarSesion } = require('../services/sesiones');

const jwtConfigurado = () => Boolean(process.env.JWT_SECRET);

function firmarToken({ userId, tenantId, perfilId }) {
    const jti = crypto.randomUUID();
    const token = jwt.sign({ userId, tenantId, perfilId, jti }, process.env.JWT_SECRET, { expiresIn: TTL_SESION });
    return { token, jti };
}

async function requireJwt(req, res, next) {
    const authorization = req.get('authorization') || '';
    const [scheme, token] = authorization.split(' ');

    if (scheme !== 'Bearer' || !token || !jwtConfigurado()) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        req.auth = jwt.verify(token, process.env.JWT_SECRET);
        if (!req.auth.userId || !req.auth.tenantId || !req.auth.perfilId || !req.auth.jti) {
            return res.status(401).json({ error: 'Invalid authentication claims' });
        }
        // Sesion efimera en Redis: el login la crea y el logout la borra
        if (!await validarSesion(req.auth.tenantId, req.auth.jti)) {
            return res.status(401).json({ error: 'Session expired or closed' });
        }
        return next();
    } catch (error) {
        console.error('❌ JWT REJECTED:', error.message);
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

module.exports = { jwtConfigurado, firmarToken, requireJwt };
