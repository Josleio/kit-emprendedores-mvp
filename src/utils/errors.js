// ============================================================================
// MANEJO DE ERRORES DE LAS RUTAS
// ----------------------------------------------------------------------------
// handleRouteError registra el error en consola y lo traduce a una respuesta HTTP:
//   42501 / 23514 -> 403  la politica RLS o un CHECK de la base de datos lo impidio
//   23505         -> 409  registro duplicado en el negocio
//   23503         -> 409  llave foranea (registro en uso o referencia inexistente)
//   otro          -> 500
// ============================================================================
function isRlsViolation(error) {
    return error && (error.code === '42501' || error.code === '23514');
}

function handleRouteError(error, res) {
    console.error('❌ BACKEND ERROR:', error.stack);
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

module.exports = { isRlsViolation, handleRouteError };
