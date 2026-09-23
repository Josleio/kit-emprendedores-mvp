require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

async function seedDatabase() {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Clean Slate: Wipe old mock data and reset IDs so the script never fails on duplicates
        await client.query('TRUNCATE app.usuarios, app.perfiles, app.tenants CASCADE');

        // 2. Insert Tenant and instantly capture the database-generated ID
        const tenantResult = await client.query(`
            INSERT INTO app.tenants (nombre, estado) 
            VALUES ('Tienda Emprendedor MVP', 'activo') 
            RETURNING tenant_id;
        `);
        const generatedTenantId = tenantResult.rows[0].tenant_id;

        // 3. Insert Profile and capture the generated ID
        const profileResult = await client.query(`
            INSERT INTO app.perfiles (nombre, descripcion) 
            VALUES ('Administrador', 'Control total de la tienda') 
            RETURNING perfil_id;
        `);
        const generatedProfileId = profileResult.rows[0].perfil_id;

        // 4. Inject the dynamic Tenant ID using the secure set_config function
        await client.query(`SELECT set_config('app.current_tenant', $1::text, true)`, [generatedTenantId]);

        // 5. Hash the password natively in Node.js (No hardcoded hashes)
        const hashedPassword = await bcrypt.hash('admin123', 10);
        
        // 6. Create the user. Forcing is_active = true ensures the login query finds it.
        await client.query(`
            INSERT INTO app.usuarios (tenant_id, perfil_id, username, password_hash, is_active) 
            VALUES ($1, $2, 'admin', $3, true)
        `, [generatedTenantId, generatedProfileId, hashedPassword]);

        await client.query('COMMIT');
        
        console.log(`✅ Database Seeded Successfully!`);
        console.log(`-----------------------------------`);
        console.log(`🔑 Login Credentials for Testing:`);
        console.log(`Tenant ID : ${generatedTenantId}`);
        console.log(`Username  : admin`);
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