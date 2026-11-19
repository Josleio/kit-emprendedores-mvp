-- ==========================================
-- 01. CLEANUP & SCHEMA RECREATION
-- ==========================================
DROP SCHEMA IF EXISTS app CASCADE;
CREATE SCHEMA app;

-- ==========================================
-- 02. DDL: GLOBAL TABLES (No tenant_id)
-- ==========================================
CREATE TABLE app.unidades_medida (
    unidad_id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL,
    abreviacion VARCHAR(15)
);

CREATE TABLE app.metodos_pago (
    metodo_pago_id SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL
);

-- ==========================================
-- 03. DDL: TENANT & RBAC TABLES
-- ==========================================
CREATE TABLE app.tenants (
    tenant_id SERIAL PRIMARY KEY,
    nombre VARCHAR(100) NOT NULL,
    estado VARCHAR(20) DEFAULT 'activo'
);

CREATE TABLE app.perfiles (
    perfil_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(50) NOT NULL,
    descripcion TEXT,
    UNIQUE (tenant_id, nombre)
);

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

-- ==========================================
-- 04. DDL: BUSINESS ENTITIES (Tenant-Scoped)
-- ==========================================
CREATE TABLE app.clientes (
    cliente_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre_completo VARCHAR(100) NOT NULL,
    telefono BIGINT
);
CREATE INDEX idx_clientes_tenant ON app.clientes(tenant_id);

CREATE TABLE app.proveedores (
    proveedor_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    nombre VARCHAR(100) NOT NULL,
    telefono BIGINT
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
    sku VARCHAR(50),
    nombre VARCHAR(100) NOT NULL,
    precio DECIMAL(10,2) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    precio_base DECIMAL(10,2) NOT NULL DEFAULT 0,
    categoria_id INT REFERENCES app.categorias(categoria_id),
    unidad_id INT REFERENCES app.unidades_medida(unidad_id),
    proveedor_id INT REFERENCES app.proveedores(proveedor_id)
);
CREATE INDEX idx_productos_tenant ON app.productos(tenant_id);

CREATE TABLE app.variantes_producto (
    variante_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    producto_id INT NOT NULL REFERENCES app.productos(producto_id) ON DELETE CASCADE,
    talla VARCHAR(45),
    color VARCHAR(45),
    sku_variante VARCHAR(50)
);
CREATE INDEX idx_variantes_tenant ON app.variantes_producto(tenant_id);

CREATE TABLE app.inventario (
    variante_id INT PRIMARY KEY REFERENCES app.variantes_producto(variante_id) ON DELETE CASCADE,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    cantidad_disponible INT NOT NULL DEFAULT 0,
    stock_minimo INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_inventario_tenant ON app.inventario(tenant_id);

CREATE TABLE app.ventas (
    venta_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    cliente_id INT NOT NULL REFERENCES app.clientes(cliente_id),
    usuario_id INT NOT NULL REFERENCES app.usuarios(usuario_id),
    fecha_venta TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    estado VARCHAR(45) DEFAULT 'completada'
);
CREATE INDEX idx_ventas_tenant ON app.ventas(tenant_id);

CREATE TABLE app.detalles_venta (
    detalle_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    venta_id INT NOT NULL REFERENCES app.ventas(venta_id) ON DELETE CASCADE,
    variante_id INT NOT NULL REFERENCES app.variantes_producto(variante_id),
    cantidad INT NOT NULL,
    precio_unitario DECIMAL(10,2) NOT NULL,
    subtotal DECIMAL(10,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED
);
CREATE INDEX idx_detalles_venta_tenant ON app.detalles_venta(tenant_id);

CREATE TABLE app.pagos (
    pago_id SERIAL PRIMARY KEY,
    tenant_id INT NOT NULL REFERENCES app.tenants(tenant_id),
    venta_id INT NOT NULL REFERENCES app.ventas(venta_id) ON DELETE CASCADE,
    metodo_pago_id INT NOT NULL REFERENCES app.metodos_pago(metodo_pago_id),
    monto DECIMAL(10,2) NOT NULL
);
CREATE INDEX idx_pagos_tenant ON app.pagos(tenant_id);
