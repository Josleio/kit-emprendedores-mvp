
-- ==========================================
-- 01. CLEANUP & SCHEMA RECREATION
-- ==========================================
DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA app;

-- ==========================================
-- 02. DDL: TABLES
-- ==========================================
-- Convencion: nombres en minuscula con guion bajo, y TODA tabla de negocio lleva tenant_id.
-- Las llaves foraneas hacia tablas de negocio son compuestas (tenant_id, id): asi la base de datos
-- impide que una fila de un negocio apunte a datos de otro negocio.

CREATE TABLE app.tenants (
    tenant_id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    estado VARCHAR(20) DEFAULT 'activo'
);

-- ------------------------------------------
-- Catalogos globales (compartidos por todos los negocios, solo lectura)
-- ------------------------------------------
CREATE TABLE app.unidades_medida (
    unidad_id SERIAL PRIMARY KEY,
    nombre VARCHAR(45) NOT NULL UNIQUE,
    abreviacion VARCHAR(10) NOT NULL UNIQUE
);

CREATE TABLE app.metodos_pago (
    metodo_pago_id SERIAL PRIMARY KEY,
    nombre VARCHAR(45) NOT NULL UNIQUE
);

-- ------------------------------------------
-- Seguridad: perfiles, modulos (nodos), permisos, usuarios
-- ------------------------------------------
-- Perfiles (roles de la tienda): pertenecen a un tenant y se administran desde el frontend
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
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    perfil_id INT NOT NULL REFERENCES app.perfiles(perfil_id),
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    UNIQUE (tenant_id, username),
    UNIQUE (tenant_id, usuario_id)
);

-- ------------------------------------------
-- Catalogo: categorias, proveedores, productos, variantes, inventario
-- ------------------------------------------
CREATE TABLE app.categorias (
    categoria_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(45) NOT NULL,
    categoria_padre_id INT REFERENCES app.categorias(categoria_id),
    UNIQUE (tenant_id, nombre),
    UNIQUE (tenant_id, categoria_id),
    CHECK (categoria_padre_id IS DISTINCT FROM categoria_id)
);

CREATE TABLE app.proveedores (
    proveedor_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(100) NOT NULL,
    telefono VARCHAR(20),               -- texto: un celular de 10 digitos no cabe en INT
    UNIQUE (tenant_id, nombre),
    UNIQUE (tenant_id, proveedor_id)
);

-- precio = precio de venta actual; costo = lo que le cuesta al negocio (necesario para margen y ROI).
-- stock se mantiene aqui para productos sin variantes (el catalogo actual lo usa).
CREATE TABLE app.productos (
    producto_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(100) NOT NULL,
    precio DECIMAL(10,2) NOT NULL CHECK (precio >= 0),
    costo DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (costo >= 0),
    stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
    referencia_almacen VARCHAR(45),
    categoria_id INT,
    proveedor_id INT,
    unidad_id INT REFERENCES app.unidades_medida(unidad_id),
    UNIQUE (tenant_id, producto_id),
    FOREIGN KEY (tenant_id, categoria_id) REFERENCES app.categorias(tenant_id, categoria_id),
    FOREIGN KEY (tenant_id, proveedor_id) REFERENCES app.proveedores(tenant_id, proveedor_id)
);

CREATE TABLE app.variantes_producto (
    variante_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    producto_id INT NOT NULL,
    nombre VARCHAR(45),
    tamano VARCHAR(45),
    color VARCHAR(45),
    referencia VARCHAR(45),
    UNIQUE (tenant_id, variante_id),
    FOREIGN KEY (tenant_id, producto_id) REFERENCES app.productos(tenant_id, producto_id) ON DELETE CASCADE
);

-- Existencias por variante (una fila por variante)
CREATE TABLE app.inventario (
    inventario_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    variante_id INT NOT NULL UNIQUE,
    existencias_actuales INT NOT NULL DEFAULT 0 CHECK (existencias_actuales >= 0),
    stock_minimo INT NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
    FOREIGN KEY (tenant_id, variante_id) REFERENCES app.variantes_producto(tenant_id, variante_id) ON DELETE CASCADE
);

-- ------------------------------------------
-- Personas: empleados y clientes (pueden tener una cuenta de acceso en usuarios)
-- ------------------------------------------
CREATE TABLE app.empleados (
    empleado_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre_completo VARCHAR(100) NOT NULL,
    usuario_id INT UNIQUE,
    UNIQUE (tenant_id, empleado_id),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES app.usuarios(tenant_id, usuario_id)
);

CREATE TABLE app.clientes (
    cliente_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre_completo VARCHAR(100) NOT NULL,
    telefono VARCHAR(20),
    usuario_id INT UNIQUE,              -- permite que el "Cliente final" inicie sesion
    UNIQUE (tenant_id, cliente_id),
    FOREIGN KEY (tenant_id, usuario_id) REFERENCES app.usuarios(tenant_id, usuario_id)
);

-- ------------------------------------------
-- Modulo transaccional: ventas, items_venta, pagos (registros inmutables, ver seccion 05)
-- ------------------------------------------
CREATE TABLE app.ventas (
    venta_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    fecha_venta TIMESTAMPTZ NOT NULL DEFAULT now(),
    estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagada', 'anulada')),
    cliente_id INT,                     -- vacio = venta de mostrador
    empleado_id INT,                    -- vacio = compra hecha por el propio cliente
    UNIQUE (tenant_id, venta_id),
    FOREIGN KEY (tenant_id, cliente_id) REFERENCES app.clientes(tenant_id, cliente_id),
    FOREIGN KEY (tenant_id, empleado_id) REFERENCES app.empleados(tenant_id, empleado_id)
);

-- precio_unitario y costo_unitario se COPIAN al momento de vender: asi el historico no cambia
-- aunque el producto cambie de precio despues, y se puede calcular el margen real de cada venta.
CREATE TABLE app.items_venta (
    item_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    venta_id INT NOT NULL,
    producto_id INT NOT NULL,
    variante_id INT,
    cantidad INT NOT NULL CHECK (cantidad > 0),
    precio_unitario DECIMAL(10,2) NOT NULL CHECK (precio_unitario >= 0),
    costo_unitario DECIMAL(10,2) NOT NULL CHECK (costo_unitario >= 0),
    subtotal DECIMAL(12,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
    FOREIGN KEY (tenant_id, venta_id) REFERENCES app.ventas(tenant_id, venta_id),
    FOREIGN KEY (tenant_id, producto_id) REFERENCES app.productos(tenant_id, producto_id),
    FOREIGN KEY (tenant_id, variante_id) REFERENCES app.variantes_producto(tenant_id, variante_id)
);

CREATE TABLE app.pagos (
    pago_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    venta_id INT NOT NULL,
    metodo_pago_id INT NOT NULL REFERENCES app.metodos_pago(metodo_pago_id),
    valor DECIMAL(12,2) NOT NULL CHECK (valor > 0),
    fecha_pago TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, venta_id) REFERENCES app.ventas(tenant_id, venta_id)
);

-- Indices para las consultas del dashboard (KPI) y para que RLS no vuelva lentas las tablas
CREATE INDEX idx_productos_tenant ON app.productos (tenant_id);
CREATE INDEX idx_variantes_producto ON app.variantes_producto (tenant_id, producto_id);
CREATE INDEX idx_ventas_tenant_fecha ON app.ventas (tenant_id, fecha_venta);
CREATE INDEX idx_items_venta_venta ON app.items_venta (tenant_id, venta_id);
CREATE INDEX idx_items_venta_producto ON app.items_venta (tenant_id, producto_id);
CREATE INDEX idx_pagos_venta ON app.pagos (tenant_id, venta_id);

-- ==========================================
-- 03. FUNCTIONS, TRIGGERS & REFERENCE DATA
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

-- Una venta registrada es inmutable: lo unico que puede cambiar es su estado (por ejemplo, anularla).
CREATE FUNCTION app.ventas_solo_estado()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id
       OR NEW.fecha_venta <> OLD.fecha_venta
       OR NEW.cliente_id IS DISTINCT FROM OLD.cliente_id
       OR NEW.empleado_id IS DISTINCT FROM OLD.empleado_id THEN
        RAISE EXCEPTION 'Solo se puede cambiar el estado de una venta registrada';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER trg_ventas_solo_estado
    BEFORE UPDATE ON app.ventas
    FOR EACH ROW EXECUTE FUNCTION app.ventas_solo_estado();

-- Datos de referencia (catalogos globales)
INSERT INTO app.unidades_medida (nombre, abreviacion) VALUES
    ('Unidad', 'und'),
    ('Kilogramo', 'kg'),
    ('Gramo', 'g'),
    ('Litro', 'l'),
    ('Metro', 'm');

INSERT INTO app.metodos_pago (nombre) VALUES
    ('Efectivo'),
    ('Tarjeta'),
    ('Transferencia');

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
ALTER TABLE app.ventas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ventas      FORCE ROW LEVEL SECURITY;
ALTER TABLE app.items_venta ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.items_venta FORCE ROW LEVEL SECURITY;
ALTER TABLE app.pagos       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pagos       FORCE ROW LEVEL SECURITY;

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

-- El stock tambien lo modifican las ventas (descuento al vender, devolucion al anular), por eso /ventas tambien puede actualizar.
CREATE POLICY productos_update ON app.productos FOR UPDATE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND (app.tiene_permiso('/catalog', 'update') OR app.tiene_permiso('/ventas', 'create') OR app.tiene_permiso('/ventas', 'update'))
    )
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND (app.tiene_permiso('/catalog', 'update') OR app.tiene_permiso('/ventas', 'create') OR app.tiene_permiso('/ventas', 'update'))
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

-- ------------------------------------------
-- TABLAS CON CRUD COMPLETO (mismo patron: aislamiento por tenant + permiso de la pantalla)
-- Se crean en un ciclo para no repetir 4 politicas por tabla.
-- Las pantallas /categorias, /proveedores, /clientes, /empleados e /inventario aun no existen en el menu:
-- hasta que se creen y se asignen permisos, nadie puede escribir en estas tablas (solo leer).
-- ------------------------------------------
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('categorias',         '/categorias'),
        ('proveedores',        '/proveedores'),
        ('clientes',           '/clientes'),
        ('empleados',          '/empleados'),
        ('variantes_producto', '/catalog'),
        ('inventario',         '/inventario')
    ) AS t(tabla, ruta)
    LOOP
        EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', r.tabla);
        EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', r.tabla);

        EXECUTE format($f$CREATE POLICY %I ON app.%I FOR SELECT
            USING (tenant_id = current_setting('app.current_tenant', true)::int)$f$,
            r.tabla || '_select', r.tabla);

        EXECUTE format($f$CREATE POLICY %I ON app.%I FOR INSERT
            WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int
                        AND app.tiene_permiso(%L, 'create'))$f$,
            r.tabla || '_insert', r.tabla, r.ruta);

        EXECUTE format($f$CREATE POLICY %I ON app.%I FOR UPDATE
            USING (tenant_id = current_setting('app.current_tenant', true)::int
                   AND app.tiene_permiso(%L, 'update'))
            WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int
                        AND app.tiene_permiso(%L, 'update'))$f$,
            r.tabla || '_update', r.tabla, r.ruta, r.ruta);

        EXECUTE format($f$CREATE POLICY %I ON app.%I FOR DELETE
            USING (tenant_id = current_setting('app.current_tenant', true)::int
                   AND app.tiene_permiso(%L, 'delete'))$f$,
            r.tabla || '_delete', r.tabla, r.ruta);
    END LOOP;
END
$$;

-- ------------------------------------------
-- VENTAS, ITEMS Y PAGOS: registros inmutables
-- Solo hay politicas de lectura e insercion. No existe politica DELETE (nadie puede borrar)
-- y items_venta/pagos tampoco tienen UPDATE. En ventas solo se puede actualizar el estado
-- (el trigger trg_ventas_solo_estado bloquea cualquier otro cambio).
-- ------------------------------------------
CREATE POLICY ventas_select ON app.ventas FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

CREATE POLICY ventas_insert ON app.ventas FOR INSERT
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/ventas', 'create')
    );

CREATE POLICY ventas_update ON app.ventas FOR UPDATE
    USING (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/ventas', 'update')
    )
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/ventas', 'update')
    );

CREATE POLICY items_venta_select ON app.items_venta FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

CREATE POLICY items_venta_insert ON app.items_venta FOR INSERT
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/ventas', 'create')
    );

CREATE POLICY pagos_select ON app.pagos FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::int);

CREATE POLICY pagos_insert ON app.pagos FOR INSERT
    WITH CHECK (
        tenant_id = current_setting('app.current_tenant', true)::int
        AND app.tiene_permiso('/ventas', 'create')
    );

-- ==========================================
-- 06. OWNERSHIP (dba permits for seeding)
-- ==========================================
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
ALTER FUNCTION app.ventas_solo_estado() OWNER TO app_dba;
