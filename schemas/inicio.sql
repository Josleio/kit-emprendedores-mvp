\echo 'Iniciando despliegue de la base de datos...'
\i 01_schema_tables.sql
\i 02_functions.sql
\i 03_security_rls.sql
\i 04_seed_data.sql
\echo 'Despliegue finalizado exitosamente.'
