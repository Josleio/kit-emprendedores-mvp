require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('./db');

// Tablas con RLS forzado: durante el seed se desactiva FORCE (dentro de la transaccion)
// porque aun no existen perfiles ni permisos que satisfagan las politicas.
const RLS_TABLES = ['perfiles', 'modulos', 'permisos', 'usuarios', 'productos'];

async function seedDatabase() {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        await client.query('TRUNCATE app.permisos, app.usuarios, app.productos, app.modulos, app.perfiles, app.tenants RESTART IDENTITY CASCADE');

        for (const table of RLS_TABLES) {
            await client.query(`ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY`);
        }

        const tenantResult = await client.query(`
            INSERT INTO app.tenants (nombre, estado) 
            VALUES ('Tienda Emprendedor MVP', 'activo') 
            RETURNING tenant_id;
        `);
        const generatedTenantId = tenantResult.rows[0].tenant_id;

        const profileResult = await client.query(`
            INSERT INTO app.perfiles (tenant_id, nombre, descripcion)
            VALUES
                ($1, 'Administrador', 'Control total de la tienda'),
                ($1, 'Cajero', 'Consulta catalogo sin administrar usuarios')
            RETURNING perfil_id, nombre;
        `, [generatedTenantId]);
        const adminProfile = profileResult.rows.find((profile) => profile.nombre === 'Administrador');
        const cashierProfile = profileResult.rows.find((profile) => profile.nombre === 'Cajero');

        // Arbol de nodos: Catalogo (hoja raiz) y Seguridad (contenedor) con sus hijos
        const addModule = async (nombre, ruta, padreId, orden, esNodo) => {
            const result = await client.query(`
                INSERT INTO app.modulos (tenant_id, nombre, ruta, padre_id, orden, es_nodo)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING modulo_id
            `, [generatedTenantId, nombre, ruta, padreId, orden, esNodo]);
            return result.rows[0].modulo_id;
        };

        const catalogModule = await addModule('Catalogo', '/catalog', null, 1, false);
        const securityNode = await addModule('Seguridad', null, null, 2, true);
        const usersModule = await addModule('Usuarios', '/users', securityNode, 1, false);
        const profilesModule = await addModule('Perfiles', '/perfiles', securityNode, 2, false);
        const permissionsModule = await addModule('Permisos', '/permisos', securityNode, 3, false);

        // Administrador: todas las pantallas. Cajero: solo consulta el catalogo.
        await client.query(`
            INSERT INTO app.permisos (perfil_id, modulo_id, can_create, can_update, can_delete)
            VALUES
                ($1, $2, true, true, true),
                ($1, $3, true, true, true),
                ($1, $4, true, true, true),
                ($1, $5, true, true, true),
                ($6, $2, false, false, false)
        `, [adminProfile.perfil_id, catalogModule, usersModule, profilesModule, permissionsModule, cashierProfile.perfil_id]);

        const adminPasswordHash = await bcrypt.hash('admin123', 12);
        const cashierPasswordHash = await bcrypt.hash('cashier123', 12);
        
        await client.query(`
            INSERT INTO app.usuarios (tenant_id, perfil_id, username, password_hash, is_active)
            VALUES
                ($1, $2, 'admin', $3, true),
                ($1, $4, 'cashier', $5, true)
        `, [generatedTenantId, adminProfile.perfil_id, adminPasswordHash, cashierProfile.perfil_id, cashierPasswordHash]);

        await client.query(`
            INSERT INTO app.productos (tenant_id, nombre, precio, stock)
            VALUES
                ($1, 'Cuaderno Emprendedor', 12.50, 25),
                ($1, 'Kit de Marcadores', 8.75, 40)
        `, [generatedTenantId]);

        for (const table of RLS_TABLES) {
            await client.query(`ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`);
        }

        await client.query('COMMIT');
        
        console.log(`✅ Database Seeded Successfully!`);
        console.log(`-----------------------------------`);
        console.log(`🔑 Login Credentials for Testing:`);
        console.log(`Tenant ID : ${generatedTenantId}`);
        console.log(`Username  : admin`);
        console.log(`Password  : admin123`);
        console.log(`Username  : cashier`);
        console.log(`Password  : cashier123`);
        console.log(`-----------------------------------`);
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Seeding failed:", err.message);
    } finally {
        client.release();
        await pool.end();
        process.exit();
    }
}

seedDatabase();
