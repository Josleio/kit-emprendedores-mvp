
-- ==========================================
-- 01. CLEANUP & SCHEMA RECREATION
-- ==========================================
DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA app;

-- ==========================================
-- 02. DDL: TABLES
-- ==========================================
CREATE TABLE app.tenants (
    tenant_id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    estado VARCHAR(20) DEFAULT 'activo'
);

-- Perfiles (roles de la tienda): ahora pertenecen a un tenant y se administran desde el frontend
CREATE TABLE app.perfiles (
    perfil_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(50) NOT NULL,
    descripcion TEXT,
    UNIQUE (tenant_id, nombre)
);

-- Modulos = nodos del menu. es_nodo = true -> contenedor (agrupa hijos, sin pantalla)
--                           es_nodo = false -> hoja (pantalla con ruta)
CREATE TABLE app.modulos (
    modulo_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(50) NOT NULL,
    ruta VARCHAR(100),
    padre_id INT REFERENCES app.modulos(modulo_id),
    orden INT NOT NULL DEFAULT 0,
    es_nodo BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (tenant_id, nombre),
    UNIQUE (tenant_id, ruta),
    CHECK (padre_id IS DISTINCT FROM modulo_id),
    CHECK ((es_nodo AND ruta IS NULL) OR (NOT es_nodo AND ruta IS NOT NULL))
);

-- Una fila = el perfil tiene acceso a esa pantalla. Las banderas definen las acciones.
CREATE TABLE app.permisos (
    perfil_id INT REFERENCES app.perfiles(perfil_id) ON DELETE CASCADE,
    modulo_id INT REFERENCES app.modulos(modulo_id) ON DELETE CASCADE,
    can_create BOOLEAN DEFAULT false,
    can_update BOOLEAN DEFAULT false,
    can_delete BOOLEAN DEFAULT false,
    PRIMARY KEY (perfil_id, modulo_id)
);

CREATE TABLE app.usuarios (
    usuario_id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES app.tenants(tenant_id),
    perfil_id INT REFERENCES app.perfiles(perfil_id),
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    UNIQUE (tenant_id, username)
);

CREATE TABLE app.productos (
    producto_id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(100) NOT NULL,
    precio DECIMAL(10,2) NOT NULL,
    stock INT DEFAULT 0 
);

-- ==========================================
-- 03. PERMISSION CHECK FUNCTION
-- ==========================================
-- Responde: "el perfil de la sesion puede hacer <accion> sobre la pantalla <ruta>?"
-- Lee app.current_perfil (lo fija withTenantTransaction) y las tablas permisos/modulos.
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

-- ==========================================
-- 04. SECURITY ROLE & GRANTS
-- ==========================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_dba') THEN
        CREATE ROLE app_dba WITH LOGIN PASSWORD 'DbaSeguro123!';
    ELSE
        ALTER ROLE app_dba WITH PASSWORD 'DbaSeguro123!';
    END IF;
END
$$;

GRANT USAGE ON SCHEMA app TO app_dba;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app TO app_dba;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app TO app_dba;
GRANT EXECUTE ON FUNCTION app.tiene_permiso(TEXT, TEXT) TO app_dba;

-- ==========================================
-- 05. ROW LEVEL SECURITY (RLS) & RBAC POLICIES
-- ==========================================
ALTER TABLE app.usuarios  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usuarios  FORCE ROW LEVEL SECURITY;
ALTER TABLE app.productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.productos FORCE ROW LEVEL SECURITY;
ALTER TABLE app.perfiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.perfiles  FORCE ROW LEVEL SECURITY;
ALTER TABLE app.modulos   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.modulos   FORCE ROW LEVEL SECURITY;
ALTER TABLE app.permisos  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.permisos  FORCE ROW LEVEL SECURITY;

-- ------------------------------------------
-- CATALOG POLICIES
-- ------------------------------------------
CREATE POLICY productos_select ON app.productos FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

CREATE POLICY productos_insert ON app.productos FOR INSERT
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/catalog', 'create')
    );

CREATE POLICY productos_update ON app.productos FOR UPDATE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/catalog', 'update')
    )
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/catalog', 'update')
    );

CREATE POLICY productos_delete ON app.productos FOR DELETE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/catalog', 'delete')
    );

-- ------------------------------------------
-- USERS POLICIES (TENANT ISOLATION + RBAC desde la tabla permisos, pantalla /users)
-- ------------------------------------------
CREATE POLICY usuarios_select ON app.usuarios FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

CREATE POLICY usuarios_insert ON app.usuarios FOR INSERT
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/users', 'create')
        AND EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = usuarios.perfil_id)
    );

CREATE POLICY usuarios_update ON app.usuarios FOR UPDATE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/users', 'update')
    )
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/users', 'update')
        AND EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = usuarios.perfil_id)
    );

CREATE POLICY usuarios_delete ON app.usuarios FOR DELETE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/users', 'delete')
    );

-- ------------------------------------------
-- PERFILES POLICIES (pantalla /perfiles)
-- ------------------------------------------
CREATE POLICY perfiles_select ON app.perfiles FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

CREATE POLICY perfiles_insert ON app.perfiles FOR INSERT
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/perfiles', 'create')
    );

CREATE POLICY perfiles_update ON app.perfiles FOR UPDATE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/perfiles', 'update')
    )
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/perfiles', 'update')
    );

CREATE POLICY perfiles_delete ON app.perfiles FOR DELETE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/perfiles', 'delete')
    );

-- ------------------------------------------
-- MODULOS (NODOS DEL MENU): solo lectura dentro del tenant (se cargan desde el seed)
-- ------------------------------------------
CREATE POLICY modulos_select ON app.modulos FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

-- ------------------------------------------
-- PERMISOS POLICIES (pantalla /permisos)
-- permisos no tiene tenant_id: el aislamiento sale del perfil y del modulo (que ya estan filtrados por RLS)
-- ------------------------------------------
CREATE POLICY permisos_select ON app.permisos FOR SELECT
    USING (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id));

CREATE POLICY permisos_insert ON app.permisos FOR INSERT
    WITH CHECK (
        EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id)
        AND EXISTS (SELECT 1 FROM app.modulos m WHERE m.modulo_id = permisos.modulo_id)
        AND app.tiene_permiso('/permisos', 'update')
    );

CREATE POLICY permisos_update ON app.permisos FOR UPDATE
    USING (
        EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id)
        AND app.tiene_permiso('/permisos', 'update')
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id)
        AND EXISTS (SELECT 1 FROM app.modulos m WHERE m.modulo_id = permisos.modulo_id)
        AND app.tiene_permiso('/permisos', 'update')
    );

CREATE POLICY permisos_delete ON app.permisos FOR DELETE
    USING (
        EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id)
        AND app.tiene_permiso('/permisos', 'delete')
    );

--dba permits for seeding
ALTER SCHEMA app OWNER TO app_dba;
ALTER TABLE app.tenants OWNER TO app_dba;
ALTER TABLE app.perfiles OWNER TO app_dba;
ALTER TABLE app.modulos OWNER TO app_dba;
ALTER TABLE app.permisos OWNER TO app_dba;
ALTER TABLE app.usuarios OWNER TO app_dba;
ALTER TABLE app.productos OWNER TO app_dba;
ALTER FUNCTION app.tiene_permiso(TEXT, TEXT) OWNER TO app_dba;
