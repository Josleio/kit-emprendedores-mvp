
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

CREATE TABLE app.perfiles (
    perfil_id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL UNIQUE,
    descripcion TEXT
);

CREATE TABLE app.modulos (
    modulo_id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL UNIQUE,
    ruta VARCHAR(100) NOT NULL
);

CREATE TABLE app.permisos (
    perfil_id INT REFERENCES app.perfiles(perfil_id),
    modulo_id INT REFERENCES app.modulos(modulo_id),
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
-- 03. SECURITY ROLE & GRANTS
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

-- ==========================================
-- 04. ROW LEVEL SECURITY (RLS) & RBAC POLICIES
-- ==========================================

-- Enable strict RLS only on business data tables
ALTER TABLE app.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usuarios FORCE ROW LEVEL SECURITY;

ALTER TABLE app.productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.productos FORCE ROW LEVEL SECURITY;

-- ------------------------------------------
-- CATALOG POLICIES
-- ------------------------------------------
CREATE POLICY catalog_tenant_isolation ON app.productos
    USING (tenant_id = current_setting('app.current_tenant', true)::int)
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int);

-- ------------------------------------------
-- USERS POLICIES (TENANT ISOLATION + RBAC)
-- ------------------------------------------
-- 1. READ: Anyone logged in can see users in their own store
CREATE POLICY usuarios_select ON app.usuarios FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

-- 2. CREATE: Only Admin (Perfil 1) can insert new users into their own store
CREATE POLICY usuarios_insert ON app.usuarios FOR INSERT
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int 
        AND current_setting('app.current_perfil', true) = '1'
    );

-- 3. UPDATE: Only Admin (Perfil 1) can edit users in their own store
CREATE POLICY usuarios_update ON app.usuarios FOR UPDATE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int 
        AND current_setting('app.current_perfil', true) = '1'
    )
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int 
        AND current_setting('app.current_perfil', true) = '1'
    );

-- 4. DELETE: Only Admin (Perfil 1) can delete users in their own store
CREATE POLICY usuarios_delete ON app.usuarios FOR DELETE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int 
        AND current_setting('app.current_perfil', true) = '1'
    );


--dba permits for seeding
ALTER SCHEMA app OWNER TO app_dba;
ALTER TABLE app.tenants OWNER TO app_dba;
ALTER TABLE app.perfiles OWNER TO app_dba;
ALTER TABLE app.modulos OWNER TO app_dba;
ALTER TABLE app.permisos OWNER TO app_dba;
ALTER TABLE app.usuarios OWNER TO app_dba;
ALTER TABLE app.productos OWNER TO app_dba;