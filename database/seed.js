// ============================================================================
// SEED DE DATOS EN POSTGRESQL (Roles, Perfiles, Usuarios bcrypt, Catalogo y Ventas)
// ----------------------------------------------------------------------------
// Pobla la base relacional con datos realistas de los ultimos 45 dias para que
// los 14 KPI (K01..K14) y las reglas de asociacion en Python generen resultados
// completos desde la primera corrida de `npm run etl`.
// ============================================================================
require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('../src/config/postgres');

const RLS_TABLES = [
    'perfiles', 'modulos', 'permisos', 'usuarios',
    'clientes', 'proveedores', 'categorias', 'productos',
    'variantes_producto', 'inventario', 'ventas', 'items_venta', 'pagos',
];

async function seedDatabase() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        for (const table of RLS_TABLES) {
            await client.query(`ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY`);
        }

        await client.query(`
            TRUNCATE app.pagos, app.items_venta, app.ventas, app.inventario,
                     app.variantes_producto, app.productos, app.categorias,
                     app.proveedores, app.clientes, app.permisos, app.usuarios,
                     app.modulos, app.perfiles, app.tenants,
                     app.roles, app.unidades_medida, app.metodos_pago
            RESTART IDENTITY CASCADE
        `);

        // 1. Catalogos globales
        const rolesRes = await client.query(`
            INSERT INTO app.roles (nombre, descripcion) VALUES
                ('Administrador', 'Supervision global, inventario y salud operativa'),
                ('Gerente', 'Analisis financiero, rentabilidad, tendencias y asociacion'),
                ('Cajero', 'Operacion diaria de caja, ventas y productos top')
            RETURNING rol_id, nombre
        `);
        const rolId = Object.fromEntries(rolesRes.rows.map((r) => [r.nombre, r.rol_id]));

        const unidadesRes = await client.query(`
            INSERT INTO app.unidades_medida (nombre, abreviacion) VALUES
                ('Unidad', 'und'),
                ('Paquete', 'paq'),
                ('Caja', 'cja')
            RETURNING unidad_id, nombre
        `);
        const unidadId = Object.fromEntries(unidadesRes.rows.map((u) => [u.nombre, u.unidad_id]));

        const metodosRes = await client.query(`
            INSERT INTO app.metodos_pago (nombre) VALUES
                ('Efectivo'),
                ('Tarjeta Debito/Credito'),
                ('Transferencia Nequi/Bancolombia')
            RETURNING metodo_pago_id, nombre
        `);
        const metodoId = Object.fromEntries(metodosRes.rows.map((m) => [m.nombre, m.metodo_pago_id]));

        // 2. Tenant principal
        const tenantRes = await client.query(`
            INSERT INTO app.tenants (nombre, estado)
            VALUES ('Tienda Emprendedor MVP', 'activo')
            RETURNING tenant_id
        `);
        const tenantId = tenantRes.rows[0].tenant_id;

        // 3. Perfiles vinculados a roles
        const perfilesRes = await client.query(`
            INSERT INTO app.perfiles (tenant_id, rol_id, nombre, descripcion) VALUES
                ($1, $2, 'Administrador General', 'Acceso total a operacion, seguridad y analitica'),
                ($1, $3, 'Gerente Comercial', 'Consulta catalogo, ventas y dashboard gerencial'),
                ($1, $4, 'Cajero Punto de Venta', 'Registra ventas, consulta catalogo y KPIs de caja')
            RETURNING perfil_id, nombre
        `, [tenantId, rolId.Administrador, rolId.Gerente, rolId.Cajero]);
        const perfilId = Object.fromEntries(perfilesRes.rows.map((p) => [p.nombre, p.perfil_id]));

        // 4. Arbol de modulos (pantallas)
        const addModulo = async (nombre, ruta, padreId, orden, esNodo) => {
            const res = await client.query(`
                INSERT INTO app.modulos (tenant_id, nombre, ruta, padre_id, orden, es_nodo)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING modulo_id
            `, [tenantId, nombre, ruta, padreId, orden, esNodo]);
            return res.rows[0].modulo_id;
        };

        const modAnaliticaNode = await addModulo('Analitica & BI', null, null, 1, true);
        const modDashboard = await addModulo('Dashboard KPI', '/analitica', modAnaliticaNode, 1, false);
        const modIntegracion = await addModulo('Integracion BD', '/integracion', modAnaliticaNode, 2, false);

        const modOperacionNode = await addModulo('Operacion', null, null, 2, true);
        const modVentas = await addModulo('Ventas', '/ventas', modOperacionNode, 1, false);
        const modCatalogo = await addModulo('Productos', '/catalog', modOperacionNode, 2, false);
        const modClientes = await addModulo('Clientes', '/clientes', modOperacionNode, 3, false);
        const modCategorias = await addModulo('Categorias', '/categorias', modOperacionNode, 4, false);
        const modProveedores = await addModulo('Proveedores', '/proveedores', modOperacionNode, 5, false);

        const modSeguridadNode = await addModulo('Seguridad (RBAC)', null, null, 3, true);
        const modUsuarios = await addModulo('Usuarios', '/users', modSeguridadNode, 1, false);
        const modPerfiles = await addModulo('Perfiles', '/perfiles', modSeguridadNode, 2, false);
        const modPermisos = await addModulo('Permisos', '/permisos', modSeguridadNode, 3, false);

        // 5. Permisos por perfil
        const allLeafs = [
            modDashboard, modIntegracion, modVentas, modCatalogo,
            modClientes, modCategorias, modProveedores, modUsuarios, modPerfiles, modPermisos,
        ];
        for (const mId of allLeafs) {
            await client.query(
                'INSERT INTO app.permisos (perfil_id, modulo_id, can_create, can_update, can_delete) VALUES ($1, $2, true, true, true)',
                [perfilId['Administrador General'], mId]
            );
        }

        // Gerente: Dashboard (con Refresh ETL), Integracion, Ventas (lectura), Catalogo (lectura/edicion), Clientes
        await client.query(`
            INSERT INTO app.permisos (perfil_id, modulo_id, can_create, can_update, can_delete) VALUES
                ($1, $2, false, true, false),
                ($1, $3, false, false, false),
                ($1, $4, false, false, false),
                ($1, $5, true, true, false),
                ($1, $6, true, true, false)
        `, [perfilId['Gerente Comercial'], modDashboard, modIntegracion, modVentas, modCatalogo, modClientes]);

        // Cajero: Dashboard (solo lectura), Ventas (crear y anular), Catalogo (lectura), Clientes (crear/lectura)
        await client.query(`
            INSERT INTO app.permisos (perfil_id, modulo_id, can_create, can_update, can_delete) VALUES
                ($1, $2, false, false, false),
                ($1, $3, true, true, false),
                ($1, $4, false, false, false),
                ($1, $5, true, false, false)
        `, [perfilId['Cajero Punto de Venta'], modDashboard, modVentas, modCatalogo, modClientes]);

        // 6. Usuarios con hash bcrypt
        const hashAdmin = await bcrypt.hash('admin123', 10);
        const hashGerente = await bcrypt.hash('gerente123', 10);
        const hashCajero = await bcrypt.hash('cajero123', 10);

        await client.query(`
            INSERT INTO app.usuarios (tenant_id, perfil_id, username, password_hash, is_active) VALUES
                ($1, $2, 'admin', $3, true),
                ($1, $4, 'gerente', $5, true),
                ($1, $6, 'cajero', $7, true)
        `, [
            tenantId,
            perfilId['Administrador General'], hashAdmin,
            perfilId['Gerente Comercial'], hashGerente,
            perfilId['Cajero Punto de Venta'], hashCajero,
        ]);

        // 7. Categorias, Proveedores, Clientes y Productos
        const catRes = await client.query(`
            INSERT INTO app.categorias (tenant_id, nombre) VALUES
                ($1, 'Papeleria y Oficina'),
                ($1, 'Tecnologia y Accesorios'),
                ($1, 'Empaques y Embalaje'),
                ($1, 'Cafeteria')
            RETURNING categoria_id, nombre
        `, [tenantId]);
        const catId = Object.fromEntries(catRes.rows.map((c) => [c.nombre, c.categoria_id]));

        const provRes = await client.query(`
            INSERT INTO app.proveedores (tenant_id, nombre, telefono) VALUES
                ($1, 'Distribuidora El Papel S.A.', '6044441122'),
                ($1, 'TechMayorista Antioquia', '3105558899'),
                ($1, 'Cafe de Origen Paisa', '3007773344')
            RETURNING proveedor_id, nombre
        `, [tenantId]);
        const provId = Object.fromEntries(provRes.rows.map((p) => [p.nombre, p.proveedor_id]));

        const cliRes = await client.query(`
            INSERT INTO app.clientes (tenant_id, nombre_completo, telefono) VALUES
                ($1, 'Laura Restrepo Gomez', '3012345678'),
                ($1, 'Carlos Andres Mejia', '3119876543'),
                ($1, 'Valentina Ortiz', '3154567890'),
                ($1, 'Comercializadora Norte', '6043216549'),
                ($1, 'Santiago Bedoya', '3206549871')
            RETURNING cliente_id
        `, [tenantId]);
        const clientes = cliRes.rows.map((c) => c.cliente_id);

        const productosSeed = [
            { nombre: 'Cuaderno Argollado 100 Hojas', precio: 14500, costo: 7200, stock: 45, ref: 'EST-A1', cat: 'Papeleria y Oficina', prov: 'Distribuidora El Papel S.A.', und: 'Unidad' },
            { nombre: 'Set Marcadores Pastel x6', precio: 18000, costo: 8500, stock: 32, ref: 'EST-A2', cat: 'Papeleria y Oficina', prov: 'Distribuidora El Papel S.A.', und: 'Paquete' },
            { nombre: 'Boligrafo Gel Negro x12', precio: 16000, costo: 7800, stock: 28, ref: 'EST-A3', cat: 'Papeleria y Oficina', prov: 'Distribuidora El Papel S.A.', und: 'Caja' },
            { nombre: 'Resma Papel Carta 75g', precio: 22000, costo: 13500, stock: 18, ref: 'BOD-B1', cat: 'Papeleria y Oficina', prov: 'Distribuidora El Papel S.A.', und: 'Paquete' },
            { nombre: 'Mouse Inalambrico Ergonomico', precio: 48000, costo: 24000, stock: 14, ref: 'TEC-01', cat: 'Tecnologia y Accesorios', prov: 'TechMayorista Antioquia', und: 'Unidad' },
            { nombre: 'Base Refrigerante Portatil', precio: 65000, costo: 34000, stock: 4, ref: 'TEC-02', cat: 'Tecnologia y Accesorios', prov: 'TechMayorista Antioquia', und: 'Unidad' },
            { nombre: 'Caja Carton Kraft x20', precio: 28000, costo: 14000, stock: 22, ref: 'EMP-01', cat: 'Empaques y Embalaje', prov: 'Distribuidora El Papel S.A.', und: 'Paquete' },
            { nombre: 'Cinta Adhesiva Industrial', precio: 9500, costo: 4200, stock: 3, ref: 'EMP-02', cat: 'Empaques y Embalaje', prov: 'Distribuidora El Papel S.A.', und: 'Unidad' },
            { nombre: 'Cafe Tostado Molido 500g', precio: 26000, costo: 13000, stock: 25, ref: 'CAF-01', cat: 'Cafeteria', prov: 'Cafe de Origen Paisa', und: 'Unidad' },
            { nombre: 'Vasos Biodegradables x50', precio: 12000, costo: 5500, stock: 30, ref: 'CAF-02', cat: 'Cafeteria', prov: 'Cafe de Origen Paisa', und: 'Paquete' },
        ];

        const productosDb = [];
        for (const p of productosSeed) {
            const pRes = await client.query(`
                INSERT INTO app.productos (tenant_id, nombre, precio, costo, stock, referencia_almacen, categoria_id, proveedor_id, unidad_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING producto_id, nombre, precio, costo
            `, [tenantId, p.nombre, p.precio, p.costo, p.stock, p.ref, catId[p.cat], provId[p.prov], unidadId[p.und]]);
            const prod = pRes.rows[0];
            productosDb.push(prod);

            // Variante e inventario inicial
            const vRes = await client.query(`
                INSERT INTO app.variantes_producto (tenant_id, producto_id, nombre, tamano, color, referencia)
                VALUES ($1, $2, 'Estandar', 'Unico', 'Original', $3)
                RETURNING variante_id
            `, [tenantId, prod.producto_id, `${p.ref}-V1`]);
            await client.query(`
                INSERT INTO app.inventario (variante_id, tenant_id, existencias_actuales, stock_minimo)
                VALUES ($1, $2, $3, 5)
            `, [vRes.rows[0].variante_id, tenantId, p.stock]);
        }

        // 8. Historial de ventas en los ultimos 45 dias (con canastas recurrentes para reglas de asociacion K14)
        const patronesCanasta = [
            [0, 1, 2],       // Cuaderno + Marcadores + Boligrafos
            [0, 1],          // Cuaderno + Marcadores
            [0, 2, 3],       // Cuaderno + Boligrafos + Resma
            [4, 5],          // Mouse + Base refrigerante
            [6, 7],          // Caja Carton + Cinta Adhesiva
            [8, 9],          // Cafe + Vasos Biodegradables
            [0, 1, 8],       // Cuaderno + Marcadores + Cafe
            [3, 2],          // Resma + Boligrafos
            [4, 3],          // Mouse + Resma
            [6, 7, 2],       // Caja + Cinta + Boligrafos
        ];
        const metodosLista = Object.values(metodoId);

        for (let i = 0; i < 36; i++) {
            const diasAtras = i % 42; // cubre ultimos 7 dias (K01), 30 dias (K05, K07) y 30-60 dias previos (K05)
            const fecha = new Date(Date.now() - diasAtras * 86400000 - (i % 8) * 3600000);
            const estado = (i === 11 || i === 27) ? 'anulada' : 'pagada'; // 2 ventas anuladas (~5.5% para K12)
            const clienteAsignado = (i % 5 === 0) ? null : clientes[i % clientes.length]; // 80% con cliente (K13)
            const metodo = metodosLista[i % metodosLista.length];
            const canasta = patronesCanasta[i % patronesCanasta.length];

            const vRes = await client.query(`
                INSERT INTO app.ventas (tenant_id, cliente_id, fecha_venta, estado)
                VALUES ($1, $2, $3, $4)
                RETURNING venta_id
            `, [tenantId, clienteAsignado, fecha, estado]);
            const ventaId = vRes.rows[0].venta_id;

            let totalVenta = 0;
            for (const prodIdx of canasta) {
                const prod = productosDb[prodIdx];
                const cantidad = (i + prodIdx) % 2 === 0 ? 2 : 1;
                await client.query(`
                    INSERT INTO app.items_venta (tenant_id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [tenantId, ventaId, prod.producto_id, cantidad, prod.precio, prod.costo]);
                totalVenta += cantidad * Number(prod.precio);
            }

            await client.query(`
                INSERT INTO app.pagos (tenant_id, venta_id, metodo_pago_id, valor)
                VALUES ($1, $2, $3, $4)
            `, [tenantId, ventaId, metodo, totalVenta]);
        }

        for (const table of RLS_TABLES) {
            await client.query(`ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`);
        }

        await client.query('COMMIT');

        console.log('✅ PostgreSQL poblado exitosamente.');
        console.log('--------------------------------------------------');
        console.log(`Tenant ID : ${tenantId}`);
        console.log('Usuarios de prueba:');
        console.log('  - admin   / admin123   (Rol: Administrador)');
        console.log('  - gerente / gerente123 (Rol: Gerente)');
        console.log('  - cajero  / cajero123  (Rol: Cajero)');
        console.log('--------------------------------------------------');
        console.log('Siguiente paso: ejecuta `npm run etl` para cargar MongoDB.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error ejecutando seed:', error.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

seedDatabase();
