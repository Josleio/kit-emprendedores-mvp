-- ==========================================
-- 05. PERMISSION CHECK FUNCTION
-- ==========================================
CREATE FUNCTION app.tiene_permiso(p_ruta TEXT, p_accion TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(bool_or(CASE p_accion
                WHEN 'read'   THEN true
                WHEN 'create' THEN pe.can_create
                WHEN 'update' THEN pe.can_update
                WHEN 'delete' THEN pe.can_delete
                ELSE false
            END), false)
    FROM app.permisos pe
    JOIN app.modulos m ON m.modulo_id = pe.modulo_id
    WHERE pe.perfil_id = NULLIF(current_setting('app.current_perfil', true), '')::int
      AND m.ruta = p_ruta
$$;
