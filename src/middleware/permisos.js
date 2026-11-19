// ============================================================================
// PERMISOS POR PERFIL (RBAC desde la base de datos)
// ----------------------------------------------------------------------------
// requirePermission(pantalla, accion) pregunta a PostgreSQL, con la funcion
// app.tiene_permiso, si el perfil de la sesion puede hacer <accion> en la pantalla:
//   'read'   -> el perfil tiene fila en permisos para esa pantalla
//   'create' | 'update' | 'delete' -> la bandera correspondiente de esa fila
// Acepta una pantalla o una lista (basta con tener permiso en una).
// Ademas de este chequeo, la base de datos aplica los mismos permisos con RLS.
// ============================================================================
const { withTenantTransaction } = require('../config/postgres');
const { handleRouteError } = require('../utils/errors');

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
            return handleRouteError(error, res);
        }
    };
}

module.exports = { requirePermission };
