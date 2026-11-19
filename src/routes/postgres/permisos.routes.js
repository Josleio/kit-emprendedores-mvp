// ============================================================================
// PERMISOS (asignacion perfil <-> pantalla)              Fuente: PostgreSQL (RLS)
// ----------------------------------------------------------------------------
// Una fila en app.permisos = el perfil tiene acceso a esa pantalla; las banderas
// can_create / can_update / can_delete definen las acciones. Los permisos se
// asignan a pantallas (hojas del arbol de modulos), nunca a contenedores.
//
//   GET    /api/permisos                      permiso: /permisos read
//   PUT    /api/permisos                      permiso: /permisos update   (crea o actualiza la asignacion)
//   DELETE /api/permisos/:perfilId/:moduloId  permiso: /permisos delete   (el perfil pierde la pantalla)
// ============================================================================
const express = require('express');
const { withTenantTransaction } = require('../../config/postgres');
const { requireJwt } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permisos');
const { parseId } = require('../../utils/validators');
const { handleRouteError } = require('../../utils/errors');

const router = express.Router();

const MODULE_COLUMNS = 'modulo_id, nombre, ruta, padre_id, orden, es_nodo';

// permiso: /permisos read
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
        return handleRouteError(error, res);
    }
});

// permiso: /permisos update
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
        return handleRouteError(error, res);
    }
});

// permiso: /permisos delete
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
        return handleRouteError(error, res);
    }
});

module.exports = router;
