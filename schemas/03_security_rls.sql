-- ==========================================
-- 06. SECURITY ROLE & GRANTS
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
-- 07. ROW LEVEL SECURITY (RLS) & RBAC POLICIES
-- ==========================================
-- Enable RLS on Tenant-Scoped Tables
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
ALTER TABLE app.detalles_venta ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.detalles_venta FORCE ROW LEVEL SECURITY;
ALTER TABLE app.pagos ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pagos FORCE ROW LEVEL SECURITY;

-- ------------------------------------------
-- USERS, PROFILES, MODULES, PERMISSIONS POLICIES
-- ------------------------------------------
CREATE POLICY usuarios_select ON app.usuarios FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY usuarios_insert ON app.usuarios FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/users', 'create') AND EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = usuarios.perfil_id));
CREATE POLICY usuarios_update ON app.usuarios FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/users', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/users', 'update') AND EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = usuarios.perfil_id));
CREATE POLICY usuarios_delete ON app.usuarios FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/users', 'delete'));

CREATE POLICY perfiles_select ON app.perfiles FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY perfiles_insert ON app.perfiles FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/perfiles', 'create'));
CREATE POLICY perfiles_update ON app.perfiles FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/perfiles', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/perfiles', 'update'));
CREATE POLICY perfiles_delete ON app.perfiles FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/perfiles', 'delete'));

CREATE POLICY modulos_select ON app.modulos FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);

CREATE POLICY permisos_select ON app.permisos FOR SELECT USING (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id));
CREATE POLICY permisos_insert ON app.permisos FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND EXISTS (SELECT 1 FROM app.modulos m WHERE m.modulo_id = permisos.modulo_id) AND app.tiene_permiso('/permisos', 'update'));
CREATE POLICY permisos_update ON app.permisos FOR UPDATE USING (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND app.tiene_permiso('/permisos', 'update')) WITH CHECK (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND EXISTS (SELECT 1 FROM app.modulos m WHERE m.modulo_id = permisos.modulo_id) AND app.tiene_permiso('/permisos', 'update'));
CREATE POLICY permisos_delete ON app.permisos FOR DELETE USING (EXISTS (SELECT 1 FROM app.perfiles p WHERE p.perfil_id = permisos.perfil_id) AND app.tiene_permiso('/permisos', 'delete'));

-- ------------------------------------------
-- CATALOG POLICIES (/catalog)
-- ------------------------------------------
-- Applied to Categorias, Productos, Variantes, and Inventario
CREATE POLICY catalog_select ON app.categorias FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY catalog_insert ON app.categorias FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'create'));
CREATE POLICY catalog_update ON app.categorias FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update'));
CREATE POLICY catalog_delete ON app.categorias FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'delete'));

CREATE POLICY productos_select ON app.productos FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY productos_insert ON app.productos FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'create'));
CREATE POLICY productos_update ON app.productos FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update'));
CREATE POLICY productos_delete ON app.productos FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'delete'));

CREATE POLICY variantes_select ON app.variantes_producto FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY variantes_insert ON app.variantes_producto FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'create'));
CREATE POLICY variantes_update ON app.variantes_producto FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update'));
CREATE POLICY variantes_delete ON app.variantes_producto FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'delete'));

CREATE POLICY inventario_select ON app.inventario FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY inventario_insert ON app.inventario FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'create'));
CREATE POLICY inventario_update ON app.inventario FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'update'));
CREATE POLICY inventario_delete ON app.inventario FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/catalog', 'delete'));

-- ------------------------------------------
-- STAKEHOLDERS POLICIES (/clientes & /proveedores)
-- ------------------------------------------
CREATE POLICY clientes_select ON app.clientes FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY clientes_insert ON app.clientes FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/clientes', 'create'));
CREATE POLICY clientes_update ON app.clientes FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/clientes', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/clientes', 'update'));
CREATE POLICY clientes_delete ON app.clientes FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/clientes', 'delete'));

CREATE POLICY proveedores_select ON app.proveedores FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY proveedores_insert ON app.proveedores FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/proveedores', 'create'));
CREATE POLICY proveedores_update ON app.proveedores FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/proveedores', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/proveedores', 'update'));
CREATE POLICY proveedores_delete ON app.proveedores FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/proveedores', 'delete'));

-- ------------------------------------------
-- SALES POLICIES (/ventas)
-- ------------------------------------------
-- Applied to Ventas, Detalles_Venta, and Pagos
CREATE POLICY ventas_select ON app.ventas FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY ventas_insert ON app.ventas FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'create'));
CREATE POLICY ventas_update ON app.ventas FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'update'));
CREATE POLICY ventas_delete ON app.ventas FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'delete'));

CREATE POLICY detalles_select ON app.detalles_venta FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY detalles_insert ON app.detalles_venta FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'create'));
CREATE POLICY detalles_update ON app.detalles_venta FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'update'));
CREATE POLICY detalles_delete ON app.detalles_venta FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'delete'));

CREATE POLICY pagos_select ON app.pagos FOR SELECT USING (tenant_id = current_setting('app.current_tenant', true)::int);
CREATE POLICY pagos_insert ON app.pagos FOR INSERT WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'create'));
CREATE POLICY pagos_update ON app.pagos FOR UPDATE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'update')) WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'update'));
CREATE POLICY pagos_delete ON app.pagos FOR DELETE USING (tenant_id = current_setting('app.current_tenant', true)::int AND app.tiene_permiso('/ventas', 'delete'));

-- ==========================================
-- 08. DBA OWNERSHIP FOR SEEDING
-- ==========================================
ALTER SCHEMA app OWNER TO app_dba;
ALTER TABLE app.unidades_medida OWNER TO app_dba;
ALTER TABLE app.metodos_pago OWNER TO app_dba;
ALTER TABLE app.tenants OWNER TO app_dba;
ALTER TABLE app.perfiles OWNER TO app_dba;
ALTER TABLE app.modulos OWNER TO app_dba;
ALTER TABLE app.permisos OWNER TO app_dba;
ALTER TABLE app.usuarios OWNER TO app_dba;
ALTER TABLE app.clientes OWNER TO app_dba;
ALTER TABLE app.proveedores OWNER TO app_dba;
ALTER TABLE app.categorias OWNER TO app_dba;
ALTER TABLE app.productos OWNER TO app_dba;
ALTER TABLE app.variantes_producto OWNER TO app_dba;
ALTER TABLE app.inventario OWNER TO app_dba;
ALTER TABLE app.ventas OWNER TO app_dba;
ALTER TABLE app.detalles_venta OWNER TO app_dba;
ALTER TABLE app.pagos OWNER TO app_dba;
ALTER FUNCTION app.tiene_permiso(TEXT, TEXT) OWNER TO app_dba;
