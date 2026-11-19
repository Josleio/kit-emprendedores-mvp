// ============================================================================
// INDICE DE RUTAS  (se monta en /api desde server.js)
// ----------------------------------------------------------------------------
//   routes/postgres/*          APIs que leen y escriben en PostgreSQL (con RLS y permisos por perfil)
//   routes/mongo/*             APIs que leen MongoDB: dashboard de KPI y log del ETL
//   routes/integracion.routes  estado de las tres bases de datos (PostgreSQL, Redis y MongoDB)
// Cada archivo declara las URL completas, asi el orden de montaje solo importa dentro de cada archivo.
// ============================================================================
const express = require('express');

const router = express.Router();

// ---- PostgreSQL
router.use(require('./postgres/auth.routes'));        // login, logout, menu
router.use(require('./postgres/catalogo.routes'));    // productos, clientes, proveedores, categorias
router.use(require('./postgres/ventas.routes'));      // ventas
router.use(require('./postgres/usuarios.routes'));    // usuarios
router.use(require('./postgres/perfiles.routes'));    // perfiles y roles
router.use(require('./postgres/permisos.routes'));    // permisos perfil <-> pantalla

// ---- MongoDB
router.use(require('./mongo/dashboard.routes'));      // KPI por rol, catalogo de KPI, log y ejecucion del ETL

// ---- Las tres bases
router.use(require('./integracion.routes'));          // estado de PostgreSQL + Redis + MongoDB

module.exports = router;
