// Genera docs/TABLA_KPIS.md a partir del catalogo real (kpis.js): la documentacion nunca se desincroniza del codigo.
const fs = require('fs');
const path = require('path');
const { catalogoPublico, ROLES } = require('../kpis');

const catalogo = catalogoPublico();
const esc = (text) => String(text).replace(/\|/g, '\\|');
let md = `# Tabla de KPI por rol\n\nGenerado automaticamente desde \`kpis.js\` (\`npm run docs\`). Cada rol tiene al menos 3 KPI.\n\n`;
md += `| Rol | KPI definidos |\n|---|---|\n${ROLES.map((r) => `| ${r} | ${catalogo.filter((k) => k.roles.includes(r)).length} |`).join('\n')}\n\n`;

for (const role of ROLES) {
    md += `## ${role}\n\n| Codigo | KPI | Definicion | Formula | Tablas fuente | Grafico | Operador ETL | Coleccion MongoDB |\n|---|---|---|---|---|---|---|---|\n`;
    for (const k of catalogo.filter((x) => x.roles.includes(role))) {
        md += `| ${k.codigo} | ${esc(k.nombre)} | ${esc(k.descripcion)} | \`${esc(k.formula)}\` | ${k.tablas.join(', ')} | ${k.visual} | ${esc(k.operador)} | ${k.coleccion} |\n`;
    }
    md += '\n';
}

md += `## Proceso ETL de cada operador de KPI

Cada KPI es un operador independiente (archivo \`kpis.js\`, ejecutado por \`etl.js\`):

1. **Extract**: consulta SQL a PostgreSQL. Corre con el contexto del negocio, por lo que RLS solo entrega datos de ese negocio.
2. **Transform**: calculo del indicador en Node.js (sumas, promedios, porcentajes, series de 30 dias).
3. **Load**: el resultado se guarda como documento en MongoDB (\`kpi_resultados\`, un documento por KPI y negocio).

Cada paso queda registrado en la coleccion \`etl_log\` (filas leidas, milisegundos de cada fase, estado). Ademas el ETL carga
\`catalogo_productos\` (catalogo documental) y \`ventas_resumen\` (ventas con sus items anidados), que usa Python para el KPI K14.
La documentacion de los KPI tambien queda en MongoDB (\`kpi_catalogo\`).

## Integracion de las tres bases de datos

| Base de datos | Funcion en la solucion |
|---|---|
| PostgreSQL | Datos transaccionales (ventas, pagos, stock), permisos por perfil y aislamiento entre negocios con RLS. |
| Redis | Sesiones efimeras: el login crea \`session:{negocio}:{id}\` con expiracion; cada peticion valida que siga activa. |
| MongoDB | Resultados de los KPI, bitacora del ETL y documentos analiticos. Alimenta el dashboard por rol. |

La pantalla **Analitica > Integracion** muestra el estado en vivo de las tres bases.
`;
fs.writeFileSync(path.join(__dirname, 'TABLA_KPIS.md'), md);
console.log('docs/TABLA_KPIS.md generado');
