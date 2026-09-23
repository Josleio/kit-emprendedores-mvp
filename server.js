require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Test DB Connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('❌ DATABASE CONNECTION FAILED:', err.message);
    else console.log('✅ SUCCESSFULLY CONNECTED TO POSTGRESQL!');
});

app.post('/api/login', async (req, res) => {
    const { tenant_id, username, password } = req.body;
    
    console.log(`\n---> NEW LOGIN ATTEMPT for Tenant: ${tenant_id}, User: ${username}`);

    // We MUST use a single client from the pool to keep the SET LOCAL context alive
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        await client.query("SELECT set_config('app.current_tenant', $1::text, true)", [tenant_id]);
        
        const query = 'SELECT usuario_id, tenant_id, perfil_id, password_hash FROM app.usuarios WHERE username = $1 AND is_active = true';
        const result = await client.query(query, [username]);

        if (result.rows.length === 0) {
            console.log('---> FAIL: Database returned 0 rows. (User hidden by RLS, wrong username, or is_active is null)');
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid credentials or tenant' });
        }

        const user = result.rows[0];
        const isValidPassword = await bcrypt.compare(password, user.password_hash);

        if (isValidPassword) {
            await client.query('COMMIT');
            console.log('---> SUCCESS: User logged in.');
            res.json({
                message: 'Login successful',
                token: 'mock-jwt-token-12345', 
                tenant_id: user.tenant_id,
                perfil_id: user.perfil_id
            });
        } else {
            console.log('---> FAIL: Bcrypt rejected the password.');
            await client.query('ROLLBACK');
            res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('---> FATAL ERROR:', err);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release(); 
    }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`Backend server running on http://localhost:${PORT}`));