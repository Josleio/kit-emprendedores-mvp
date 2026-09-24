require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('./db');

async function seedDatabase() {
    const client = await pool.connect();
    
    try {

        await client.query('BEGIN');
        await client.query('TRUNCATE app.usuarios, app.productos, app.perfiles, app.modulos, app.tenants RESTART IDENTITY CASCADE');

        // Tenant 1
        const tenantResult = await client.query(`
            INSERT INTO app.tenants (nombre, estado) 
            VALUES ('Tienda Emprendedor MVP', 'activo') 
            RETURNING tenant_id;
        `);
        const tenant1Id = tenantResult.rows[0].tenant_id;

        await client.query(`
            INSERT INTO app.perfiles (nombre, descripcion)
            VALUES
                ('Administrador', 'Control total de la tienda'),
                ('Cajero', 'Consulta catalogo sin administrar usuarios');
        `);

        const moduleResult = await client.query(`
            INSERT INTO app.modulos (nombre, ruta)
            VALUES
                ('Catalogo', '/catalog'),
                ('Usuarios', '/users')
            RETURNING modulo_id, nombre;
        `);

        const catalogModule = moduleResult.rows.find((module) => module.nombre === 'Catalogo');
        const usersModule = moduleResult.rows.find((module) => module.nombre === 'Usuarios');

        await client.query(`
            INSERT INTO app.permisos (perfil_id, modulo_id, can_create, can_update, can_delete)
            VALUES
                (1, $1, true, true, true),
                (1, $2, true, true, true),
                (2, $1, false, false, false)
        `, [catalogModule.modulo_id, usersModule.modulo_id]);

        await client.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [tenant1Id]);
        await client.query("SELECT set_config('app.current_perfil', $1::text, true)", ['1']);

        const adminPasswordHash = await bcrypt.hash('admin123', 12);
        const cashierPasswordHash = await bcrypt.hash('cashier123', 12);
        
        await client.query(`
            INSERT INTO app.usuarios (tenant_id, perfil_id, username, password_hash, is_active)
            VALUES
                ($1, 1, 'admin', $2, true),
                ($1, 2, 'cashier', $3, true)
        `, [tenant1Id, adminPasswordHash, cashierPasswordHash]);

        await client.query(`
            INSERT INTO app.productos (tenant_id, nombre, precio, stock)
            VALUES
                ($1, 'Cuaderno Emprendedor', 12.50, 25),
                ($1, 'Kit de Marcadores', 8.75, 40)
        `, [tenant1Id]);

        // Tenant 2
        const tenantResult2 = await client.query(`
            INSERT INTO app.tenants (nombre, estado) 
            VALUES ('Tienda Alternativa MVP', 'activo') 
            RETURNING tenant_id;
        `);
        const tenant2Id = tenantResult2.rows[0].tenant_id;

        await client.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [tenant2Id]);
        await client.query("SELECT set_config('app.current_perfil', $1::text, true)", ['1']);

        const admin2PasswordHash = await bcrypt.hash('admin123', 12);

        await client.query(`
            INSERT INTO app.usuarios (tenant_id, perfil_id, username, password_hash, is_active)
            VALUES ($1, 1, 'admin_store2', $2, true)
        `, [tenant2Id, admin2PasswordHash]);

        await client.query(`
            INSERT INTO app.productos (tenant_id, nombre, precio, stock)
            VALUES
                ($1, 'Producto Tienda 2 - A', 15.99, 30),
                ($1, 'Producto Tienda 2 - B', 22.50, 15)
        `, [tenant2Id]);

        await client.query('COMMIT');
        
        console.log(`✅ Database Seeded Successfully!`);
        console.log(`-----------------------------------`);
        console.log(`🔑 Login Credentials for Testing:`);
        console.log(`\n📦 Tenant 1: Tienda Emprendedor MVP`);
        console.log(`Tenant ID : ${tenant1Id}`);
        console.log(`Username  : admin`);
        console.log(`Password  : admin123`);
        console.log(`Username  : cashier`);
        console.log(`Password  : cashier123`);
        console.log(`\n📦 Tenant 2: Tienda Alternativa MVP`);
        console.log(`Tenant ID : ${tenant2Id}`);
        console.log(`Username  : admin_store2`);
        console.log(`Password  : admin123`);
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