// ============================================================================
// MONGODB = RESULTADOS DE KPI, BITACORA DEL ETL Y DOCUMENTOS ANALITICOS
// ----------------------------------------------------------------------------
// Conexion con mongoose. Se conecta solo cuando se necesita (getMongo) y falla rapido
// (3 s) si el servicio esta apagado: las rutas responden 503 en lugar de quedarse colgadas.
// Devuelve el objeto "db" nativo del driver (db.collection('...')).
// ============================================================================
require('dotenv').config();
const mongoose = require('mongoose');

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.MONGO_DB || 'kit_emprendedores';
let connecting = null;

async function getMongo() {
    if (mongoose.connection.readyState !== 1) {
        if (!connecting) {
            connecting = mongoose
                .connect(uri, { dbName, serverSelectionTimeoutMS: 3000 })
                .finally(() => { connecting = null; });
        }
        await connecting;
        console.log(`✅ Conectado a MongoDB (${dbName}).`);
    }
    return mongoose.connection.db;
}

async function closeMongo() {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
}

module.exports = { getMongo, closeMongo };
