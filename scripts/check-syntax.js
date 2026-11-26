// ============================================================================
// VERIFICADOR DE SINTAXIS DE TODO EL PROYECTO (npm run check)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const IGNORED = new Set(['node_modules', '.git', 'salida']);

function listarJs(dir) {
    const archivos = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            archivos.push(...listarJs(full));
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            archivos.push(full);
        }
    }
    return archivos;
}

const files = listarJs(ROOT);
let errores = 0;

for (const file of files) {
    const rel = path.relative(ROOT, file);
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
        errores += 1;
        console.error(`❌ Error de sintaxis en ${rel}:\n${err.stderr.toString()}`);
    }
}

if (errores > 0) {
    console.error(`\nFallaron ${errores} de ${files.length} archivos JS.`);
    process.exit(1);
}

console.log(`✅ Sintaxis OK en ${files.length} archivos JS.`);
