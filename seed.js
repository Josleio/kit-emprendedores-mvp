require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('./db');

// Generador pseudoaleatorio con semilla: cada vez que corres el seed salen los mismos datos de prueba.
let seedState = 20261116;
const rand = () => { seedState = (seedState * 1664525 + 1013904223) % 4294967296; return seedState / 4294967296; };
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));

async function seedDatabase() {
    const client = await pool.connect();
    let rlsTables = [];

    try {
        await client.query('BEGIN');

        // Durante el seed se desactiva FORCE RLS (dentro de la transaccion) porque aun no existen perfiles ni permisos.
        const forced = await client.query(`
            SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'app' AND c.relkind = 'r' AND c.relforcerowsecurity
        `);
        rlsTables = forced.rows.map((row) => row.relname);

        await client.query('TRUNCATE app.tenants RESTART IDENTITY CASCADE');
        for (const table of rlsTables) {
            await client.query(`ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY`);
        }

// ---------- Roles globales ----------
        const baseRoles = ['Administrador', 'Gerente', 'Cajero'];
        const existingRoles = (await client.query('SELECT rol_id, nombre FROM app.roles')).rows;
        const existingSet = new Set(existingRoles.map((r) => r.nombre.trim().toLowerCase()));

        for (const roleName of baseRoles) {
            if (!existingSet.has(roleName.toLowerCase())) {
                await client.query('INSERT INTO app.roles (nombre) VALUES ($1)', [roleName]);
            }
        }

        const rolesRows = (await client.query('SELECT rol_id, nombre FROM app.roles')).rows;
        const rolesMap = Object.fromEntries(
            rolesRows.map((r) => [r.nombre.trim().toLowerCase(), r.rol_id])
        );
        
        // ---------- Tenant y perfiles ----------
        const tenantId = (await client.query(`
            INSERT INTO app.tenants (nombre, estado) VALUES ('Tienda Emprendedor MVP', 'activo') RETURNING tenant_id
        `)).rows[0].tenant_id;

        const profiles = {};
        for (const [nombre, descripcion] of [
            ['Administrador', 'Control total de la tienda'],
            ['Cajero', 'Registra ventas y consulta el catalogo'],
            ['Gerente', 'Consulta ventas y analitica del negocio'],
        ]) {
            const rolId = rolesMap[nombre.toLowerCase()];
            if (!rolId) {
                throw new Error(`No se encontro el rol "${nombre}" en app.roles`);
            }
            profiles[nombre] = (await client.query(
                'INSERT INTO app.perfiles (tenant_id, rol_id, nombre, descripcion) VALUES ($1, $2, $3, $4) RETURNING perfil_id',
                [tenantId, rolId, nombre, descripcion]
            )).rows[0].perfil_id;
        }

        // ---------- Arbol de nodos (menu) ----------
        const modules = {};
        const addModule = async (nombre, ruta, padreId, orden, esNodo) => {
            const id = (await client.query(`
                INSERT INTO app.modulos (tenant_id, nombre, ruta, padre_id, orden, es_nodo)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING modulo_id
            `, [tenantId, nombre, ruta, padreId, orden, esNodo])).rows[0].modulo_id;
            if (ruta) modules[ruta] = id;
            return id;
        };
        const comercial = await addModule('Comercial', null, null, 1, true);
        await addModule('Ventas', '/ventas', comercial, 1, false);
        await addModule('Clientes', '/clientes', comercial, 2, false);
        const inventario = await addModule('Inventario', null, null, 2, true);
        await addModule('Catalogo', '/catalog', inventario, 1, false);
        await addModule('Categorias', '/categorias', inventario, 2, false);
        await addModule('Proveedores', '/proveedores', inventario, 3, false);
        const analitica = await addModule('Analitica', null, null, 3, true);
        await addModule('Dashboard KPI', '/analitica', analitica, 1, false);
        await addModule('Integracion', '/integracion', analitica, 2, false);
        const seguridad = await addModule('Seguridad', null, null, 4, true);
        await addModule('Usuarios', '/users', seguridad, 1, false);
        await addModule('Perfiles', '/perfiles', seguridad, 2, false);
        await addModule('Permisos', '/permisos', seguridad, 3, false);

        // ---------- Permisos (crear, actualizar, eliminar) ----------
        const grant = (perfil, ruta, c, u, d) => client.query(
            'INSERT INTO app.permisos (perfil_id, modulo_id, can_create, can_update, can_delete) VALUES ($1, $2, $3, $4, $5)',
            [profiles[perfil], modules[ruta], c, u, d]
        );
        for (const ruta of Object.keys(modules)) await grant('Administrador', ruta, true, true, true);
        await grant('Cajero', '/ventas', true, false, false);
        await grant('Cajero', '/clientes', true, true, false);
        await grant('Cajero', '/catalog', false, false, false);
        await grant('Cajero', '/analitica', false, false, false);    // ve su dashboard de KPI
        await grant('Gerente', '/ventas', false, true, false);      // puede anular ventas
        await grant('Gerente', '/catalog', false, false, false);
        await grant('Gerente', '/clientes', false, false, false);
        await grant('Gerente', '/analitica', false, true, false);   // update = actualizar datos (ETL)
        await grant('Gerente', '/integracion', false, false, false);

        // ---------- Usuarios (contrasenas con bcrypt) ----------
        for (const [username, password, perfil] of [
            ['admin', 'admin123', 'Administrador'],
            ['cashier', 'cashier123', 'Cajero'],
            ['gerente', 'gerente123', 'Gerente'],
        ]) {
            await client.query(
                'INSERT INTO app.usuarios (tenant_id, perfil_id, username, password_hash, is_active) VALUES ($1, $2, $3, $4, true)',
                [tenantId, profiles[perfil], username, await bcrypt.hash(password, 12)]
            );
        }

        // ---------- Catalogo ----------
        const ids = async (sql, rows) => {
            const out = [];
            for (const r of rows) out.push((await client.query(sql, [tenantId, ...r])).rows[0].id);
            return out;
        };
        const [catPapel, catArte, catOficina] = await ids(
            'INSERT INTO app.categorias (tenant_id, nombre) VALUES ($1, $2) RETURNING categoria_id AS id',
            [['Papeleria'], ['Arte'], ['Oficina']]);
        const [provAndina, provValle] = await ids(
            'INSERT INTO app.proveedores (tenant_id, nombre, telefono) VALUES ($1, $2, $3) RETURNING proveedor_id AS id',
            [['Distribuidora Andina', '3001234567'], ['Papeles del Valle', '3109876543']]);

        const unidadRow = (await client.query("SELECT unidad_id FROM app.unidades_medida WHERE abreviacion = 'und'")).rows[0];
        if (!unidadRow) {
            throw new Error("No existe la unidad de medida 'und' en app.unidades_medida");
        }
        const unidad = unidadRow.unidad_id;

        // nombre, precio, costo, categoria, proveedor, margen de stock sobrante (bajo = aparecera en "stock bajo")
        const catalog = [
            ['Cuaderno Emprendedor', 12.50, 6.00, catPapel, provAndina, 18],
            ['Kit de Marcadores', 8.75, 4.20, catArte, provAndina, 22],
            ['Lapices x12', 5.00, 2.10, catPapel, provValle, 30],
            ['Resaltadores x6', 6.50, 3.00, catPapel, provValle, 14],
            ['Carpeta Plastica', 3.20, 1.20, catOficina, provValle, 40],
            ['Agenda 2027', 15.90, 8.50, catOficina, provAndina, 3],
            ['Set de Pinceles', 11.00, 5.50, catArte, provAndina, 9],
            ['Acuarelas', 18.00, 10.50, catArte, provValle, 4],
        ];
        const products = [];
        for (const [i, [nombre, precio, costo, cat, prov]] of catalog.entries()) {
            const id = (await client.query(`
                INSERT INTO app.productos (tenant_id, nombre, precio, costo, stock, referencia_almacen, categoria_id, proveedor_id, unidad_id)
                VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8) RETURNING producto_id
            `, [tenantId, nombre, precio, costo, `REF-${String(i + 1).padStart(3, '0')}`, cat, prov, unidad])).rows[0].producto_id;
            products.push({ id, nombre, precio, costo, sold: 0, extra: catalog[i][5] });
        }

        // ---------- Clientes ----------
        const clientIds = await ids(
            'INSERT INTO app.clientes (tenant_id, nombre_completo, telefono) VALUES ($1, $2, $3) RETURNING cliente_id AS id',
            [['Laura Gomez', '3015550101'], ['Carlos Ruiz', '3025550102'], ['Marta Perez', '3035550103'],
             ['Andres Mejia', '3045550104'], ['Sofia Torres', '3055550105'], ['Julian Castro', '3065550106']]);

        // ---------- Ventas de los ultimos 60 dias (con combos que se compran juntos) ----------
        const metodos = (await client.query('SELECT metodo_pago_id FROM app.metodos_pago ORDER BY metodo_pago_id')).rows.map((r) => r.metodo_pago_id);
        if (metodos.length === 0) {
            throw new Error('No hay metodos de pago cargados en app.metodos_pago');
        }
        const combos = [[0, 1], [2, 3], [5, 4]];
        const now = Date.now();
        const sales = [];
        for (let n = 0; n < 90; n++) {
            const when = new Date(now - randInt(0, 59) * 86400000);
            when.setHours(randInt(9, 19), randInt(0, 59), 0, 0);
            const lines = new Map();
            const roll = rand();
            if (roll < 0.35) combos[0].forEach((p) => lines.set(p, randInt(1, 2)));
            else if (roll < 0.55) combos[1].forEach((p) => lines.set(p, randInt(1, 3)));
            else if (roll < 0.70) combos[2].forEach((p) => lines.set(p, 1));
            else for (let k = randInt(1, 3); k > 0; k--) lines.set(randInt(0, products.length - 1), randInt(1, 3));
            sales.push({
                when, lines,
                cliente: rand() < 0.7 ? clientIds[randInt(0, clientIds.length - 1)] : null,
                metodo: metodos[randInt(0, metodos.length - 1)],
                anulada: rand() < 0.08,
            });
        }
        sales.sort((a, b) => a.when - b.when);

        for (const sale of sales) {
            const ventaId = (await client.query(
                'INSERT INTO app.ventas (tenant_id, fecha_venta, estado, cliente_id) VALUES ($1, $2, $3, $4) RETURNING venta_id',
                [tenantId, sale.when, sale.anulada ? 'anulada' : 'pagada', sale.cliente]
            )).rows[0].venta_id;
            let total = 0;
            for (const [index, qty] of sale.lines) {
                const p = products[index];
                await client.query(`
                    INSERT INTO app.items_venta (tenant_id, venta_id, producto_id, cantidad, precio_unitario, costo_unitario)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [tenantId, ventaId, p.id, qty, p.precio, p.costo]);
                total += qty * p.precio;
                if (!sale.anulada) p.sold += qty;
            }
            if (!sale.anulada) {
                await client.query(
                    'INSERT INTO app.pagos (tenant_id, venta_id, metodo_pago_id, valor, fecha_pago) VALUES ($1, $2, $3, $4, $5)',
                    [tenantId, ventaId, sale.metodo, total.toFixed(2), sale.when]
                );
            }
        }

        // Stock actual = lo que se vendio + un sobrante (asi algunos productos quedan con stock bajo)
        for (const p of products) {
            await client.query('UPDATE app.productos SET stock = $1 WHERE producto_id = $2', [p.sold + p.extra, p.id]);
        }

        for (const table of rlsTables) {
            await client.query(`ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`);
        }
        await client.query('COMMIT');

        console.log('✅ Database Seeded Successfully!');
        console.log('-----------------------------------');
        console.log('🔑 Login Credentials for Testing:');
        console.log(`Tenant ID : ${tenantId}`);
        console.log('admin   / admin123    (Administrador: todo)');
        console.log('cashier / cashier123  (Cajero: vende y consulta el catalogo)');
        console.log('gerente / gerente123  (Gerente: ve ventas y analitica)');
        console.log(`Datos de prueba: ${products.length} productos, ${clientIds.length} clientes, ${sales.length} ventas`);
        console.log('-----------------------------------');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Seeding failed:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

seedDatabase();