-- ============================================================================
-- ESQUEMA COMPLETO POSTGRESQL: TABLAS, RBAC, TRIGGERS DE INMUTABILIDAD Y RLS
-- ----------------------------------------------------------------------------
-- Ejecutar en pgAdmin o psql contra la base kit_emprendedores antes de npm run seed:
--   psql -U postgres -d kit_emprendedores -f database/schema.sql
-- ============================================================================

DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA app;

-- ============================================================================
-- 1. CATALOGOS GLOBALES (Compartidos entre todos los negocios)
-- ============================================================================
CREATE TABLE app.roles (
    rol_id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL UNIQUE,
    descripcion TEXT
);

CREATE TABLE app.unidades_medida (
    unidad_id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL,
    abreviacion VARCHAR(15)
);

CREATE TABLE app.metodos_pago (
    metodo_pago_id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL
);

-- ============================================================================
-- 2. MULTI-TENANT Y SEGURIDAD RBAC
-- ============================================================================
CREATE TABLE app.tenants (
    tenant_id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    estado VARCHAR(20) DEFAULT 'activo'
);

CREATE TABLE app.perfiles (
    perfil_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    rol_id INT NOT NULL REFERENCES app.roles(rol_id),
    nombre VARCHAR(50) NOT NULL,
    descripcion TEXT,
    UNIQUE (tenant_id, nombre)
);
CREATE INDEX idx_perfiles_tenant ON app.perfiles(tenant_id);

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
CREATE INDEX idx_modulos_tenant ON app.modulos(tenant_id);

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
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    perfil_id INT NOT NULL REFERENCES app.perfiles(perfil_id),
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    UNIQUE (tenant_id, username)
);
CREATE INDEX idx_usuarios_tenant ON app.usuarios(tenant_id);

-- ============================================================================
-- 3. ENTIDADES DEL NEGOCIO (Aisladas por tenant_id)
-- ============================================================================
CREATE TABLE app.clientes (
    cliente_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre_completo VARCHAR(100) NOT NULL,
    telefono VARCHAR(20)
);
CREATE INDEX idx_clientes_tenant ON app.clientes(tenant_id);

CREATE TABLE app.proveedores (
    proveedor_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(100) NOT NULL,
    telefono VARCHAR(20)
);
CREATE INDEX idx_proveedores_tenant ON app.proveedores(tenant_id);

CREATE TABLE app.categorias (
    categoria_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(50) NOT NULL,
    padre_id INT REFERENCES app.categorias(categoria_id)
);
CREATE INDEX idx_categorias_tenant ON app.categorias(tenant_id);

CREATE TABLE app.productos (
    producto_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(100) NOT NULL,
    precio DECIMAL(10,2) NOT NULL CHECK (precio >= 0),
    costo DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (costo >= 0),
    stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
    referencia_almacen VARCHAR(45),
    categoria_id INT REFERENCES app.categorias(categoria_id) ON DELETE SET NULL,
    proveedor_id INT REFERENCES app.proveedores(proveedor_id) ON DELETE SET NULL,
    unidad_id INT REFERENCES app.unidades_medida(unidad_id) ON DELETE SET NULL
);
CREATE INDEX idx_productos_tenant ON app.productos(tenant_id);

CREATE TABLE app.variantes_producto (
    variante_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    producto_id INT NOT NULL REFERENCES app.productos(producto_id) ON DELETE CASCADE,
    nombre VARCHAR(80),
    tamano VARCHAR(45),
    color VARCHAR(45),
    referencia VARCHAR(50)
);
CREATE INDEX idx_variantes_tenant ON app.variantes_producto(tenant_id);

CREATE TABLE app.inventario (
    variante_id INT PRIMARY KEY REFERENCES app.variantes_producto(variante_id) ON DELETE CASCADE,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    existencias_actuales INT NOT NULL DEFAULT 0,
    stock_minimo INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_inventario_tenant ON app.inventario(tenant_id);

CREATE TABLE app.ventas (
    venta_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    cliente_id INT REFERENCES app.clientes(cliente_id) ON DELETE SET NULL,
    fecha_venta TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    estado VARCHAR(20) NOT NULL DEFAULT 'pagada' CHECK (estado IN ('pagada', 'anulada'))
);
CREATE INDEX idx_ventas_tenant ON app.ventas(tenant_id);
CREATE INDEX idx_ventas_fecha ON app.ventas(tenant_id, fecha_venta);

CREATE TABLE app.items_venta (
    item_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    venta_id INT NOT NULL REFERENCES app.ventas(venta_id) ON DELETE CASCADE,
    producto_id INT NOT NULL REFERENCES app.productos(producto_id),
    cantidad INT NOT NULL CHECK (cantidad > 0),
    precio_unitario DECIMAL(10,2) NOT NULL CHECK (precio_unitario >= 0),
    costo_unitario DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (costo_unitario >= 0),
    subtotal DECIMAL(10,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED
);
CREATE INDEX idx_items_venta_tenant ON app.items_venta(tenant_id);
CREATE INDEX idx_items_venta_venta ON app.items_venta(venta_id);

CREATE TABLE app.pagos (
    pago_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    venta_id INT NOT NULL REFERENCES app.ventas(venta_id) ON DELETE CASCADE,
    metodo_pago_id INT NOT NULL REFERENCES app.metodos_pago(metodo_pago_id),
    valor DECIMAL(10,2) NOT NULL CHECK (valor >= 0)
);
CREATE INDEX idx_pagos_tenant ON app.pagos(tenant_id);

-- ============================================================================
-- 4. FUNCIONES Y TRIGGERS DE INTEGRIDAD
-- ============================================================================
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

-- Inmutabilidad de ventas: solo permite pasar de 'pagada' a 'anulada'
CREATE FUNCTION app.validar_anulacion_venta()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.estado = 'anulada' THEN
        RAISE EXCEPTION 'Una venta anulada no puede modificarse' USING ERRCODE = '23514';
    END IF;
    IF NEW.estado <> 'anulada'
       OR NEW.venta_id <> OLD.venta_id
       OR NEW.tenant_id <> OLD.tenant_id
       OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
       OR NEW.fecha_venta <> OLD.fecha_venta THEN
        RAISE EXCEPTION 'Las ventas son inmutables: solo se permite anular' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ventas_inmutables
    BEFORE UPDATE ON app.ventas
    FOR EACH ROW
    EXECUTE FUNCTION app.validar_anulacion_venta();

-- ============================================================================
-- 5. ROW LEVEL SECURITY (RLS) Y POLITICAS POR PERFIL
-- ============================================================================
ALTER TABLE app.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.usuarios FORCE ROW LEVEL SECURITY;
ALTER TABLE app.perfiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.perfiles FORCE ROW LEVEL SECURITY;
ALTER TABLE app.modulos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.modulos FORCE ROW LEVEL SECURITY;
ALTER TABLE app.permisos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.permisos FORCE ROW LEVEL SECURITY;
ALTER TABLE app.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.clientes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.proveedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.proveedores FORCE ROW LEVEL SECURITY;
ALTER TABLE app.categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.categorias FORCE ROW LEVEL SECURITY;
ALTER TABLE app.productos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.productos FORCE ROW LEVEL SECURITY;
ALTER TABLE app.variantes_producto ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.variantes_producto FORCE ROW LEVEL SECURITY;
ALTER TABLE app.inventario ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inventario FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ventas ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ventas FORCE ROW LEVEL SECURITY;
ALTER TABLE app.items_venta ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.items_venta FORCE ROW LEVEL SECURITY;
ALTER TABLE app.pagos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pagos FORCE ROW LEVEL SECURITY;

-- Usuarios, perfiles, modulos y permisos
CREATE POLICY usuarios_select ON app.usuarios FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY usuarios_insert ON app.usuarios FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/users', 'create'));
CREATE POLICY usuarios_update ON app.usuarios FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/users', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/users', 'update'));
CREATE POLICY usuarios_delete ON app.usuarios FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/users', 'delete'));

CREATE POLICY perfiles_select ON app.perfiles FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY perfiles_insert ON app.perfiles FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/perfiles', 'create'));
CREATE POLICY perfiles_update ON app.perfiles FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/perfiles', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/perfiles', 'update'));
CREATE POLICY perfiles_delete ON app.perfiles FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/perfiles', 'delete'));

CREATE POLICY modulos_select ON app.modulos FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);

CREATE POLICY permisos_select ON app.permisos FOR SELECT USING (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id));
CREATE POLICY permisos_insert ON app.permisos FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND app.tiene_permiso('/permisos', 'update'));
CREATE POLICY permisos_update ON app.permisos FOR UPDATE USING (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND app.tiene_permiso('/permisos', 'update')) WITH CHECK (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND app.tiene_permiso('/permisos', 'update'));
CREATE POLICY permisos_delete ON app.permisos FOR DELETE USING (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND app.tiene_permiso('/permisos', 'delete'));

-- Maestros (/categorias, /proveedores, /clientes)
CREATE POLICY categorias_select ON app.categorias FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY categorias_insert ON app.categorias FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/categorias', 'create'));
CREATE POLICY categorias_update ON app.categorias FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/categorias', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/categorias', 'update'));
CREATE POLICY categorias_delete ON app.categorias FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/categorias', 'delete'));

CREATE POLICY clientes_select ON app.clientes FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY clientes_insert ON app.clientes FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/clientes', 'create'));
CREATE POLICY clientes_update ON app.clientes FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/clientes', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/clientes', 'update'));
CREATE POLICY clientes_delete ON app.clientes FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/clientes', 'delete'));

CREATE POLICY proveedores_select ON app.proveedores FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY proveedores_insert ON app.proveedores FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/proveedores', 'create'));
CREATE POLICY proveedores_update ON app.proveedores FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/proveedores', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/proveedores', 'update'));
CREATE POLICY proveedores_delete ON app.proveedores FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/proveedores', 'delete'));

-- Catalogo e inventario (/catalog y ajuste de stock desde /ventas)
CREATE POLICY productos_select ON app.productos FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY productos_insert ON app.productos FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'create'));
CREATE POLICY productos_update ON app.productos FOR UPDATE
    USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND (app.tiene_permiso('/catalog', 'update') OR app.tiene_permiso('/ventas', 'create') OR app.tiene_permiso('/ventas', 'update')))
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND (app.tiene_permiso('/catalog', 'update') OR app.tiene_permiso('/ventas', 'create') OR app.tiene_permiso('/ventas', 'update')));
CREATE POLICY productos_delete ON app.productos FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'delete'));

CREATE POLICY variantes_select ON app.variantes_producto FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY variantes_insert ON app.variantes_producto FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'create'));
CREATE POLICY variantes_update ON app.variantes_producto FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'update'));
CREATE POLICY variantes_delete ON app.variantes_producto FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'delete'));

CREATE POLICY inventario_select ON app.inventario FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY inventario_insert ON app.inventario FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'create'));
CREATE POLICY inventario_update ON app.inventario FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'update'));
CREATE POLICY inventario_delete ON app.inventario FOR DELETE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/catalog', 'delete'));

-- Ventas inmutables (sin politicas DELETE)
CREATE POLICY ventas_select ON app.ventas FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY ventas_insert ON app.ventas FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/ventas', 'create'));
CREATE POLICY ventas_update ON app.ventas FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/ventas', 'update')) WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/ventas', 'update'));

CREATE POLICY items_venta_select ON app.items_venta FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY items_venta_insert ON app.items_venta FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/ventas', 'create'));

CREATE POLICY pagos_select ON app.pagos FOR SELECT USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int);
CREATE POLICY pagos_insert ON app.pagos FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::int AND app.tiene_permiso('/ventas', 'create'));

-- ============================================================================
-- 6. ROL DE APLICACION (app_dba), PERMISOS Y SEARCH_PATH
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_dba') THEN
        CREATE ROLE app_dba WITH LOGIN PASSWORD 'DbaSeguro123!';
    ELSE
        ALTER ROLE app_dba WITH LOGIN PASSWORD 'DbaSeguro123!';
    END IF;

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_dba', current_database());
END
$$;

GRANT USAGE, CREATE ON SCHEMA app TO app_dba;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app TO app_dba;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA app TO app_dba;
GRANT EXECUTE ON FUNCTION app.tiene_permiso(TEXT, TEXT) TO app_dba;
GRANT EXECUTE ON FUNCTION app.validar_anulacion_venta() TO app_dba;

ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON TABLES TO app_dba;
ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL ON SEQUENCES TO app_dba;
ALTER ROLE app_dba SET search_path TO app, public;

-- ============================================================================
-- 7. OWNERSHIP (Propietario del esquema, tablas y funciones)
-- ============================================================================
ALTER SCHEMA app OWNER TO app_dba;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
        EXECUTE format('ALTER TABLE app.%I OWNER TO app_dba', r.tablename);
    END LOOP;
END
$$;

ALTER FUNCTION app.tiene_permiso(TEXT, TEXT) OWNER TO app_dba;
ALTER FUNCTION app.validar_anulacion_venta() OWNER TO app_dba;