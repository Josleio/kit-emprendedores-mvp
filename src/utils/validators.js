// ============================================================================
// VALIDACIONES DE ENTRADA (compartidas por las rutas de PostgreSQL)
// ----------------------------------------------------------------------------
// Convencion: las funciones que validan un campo devuelven { value } o { error },
// y collect() las une: devuelve el primer error o el objeto con todos los valores.
// ============================================================================
function validateText(value, field, maxLength) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
        return `${field} is required and must be at most ${maxLength} characters`;
    }
    return null;
}

function parseId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function idOrNull(value) {
    if (value === null || value === undefined || value === '') return { value: null };
    const id = parseId(value);
    return id ? { value: id } : { error: 'Invalid reference' };
}

function optionalText(value, field, max) {
    if (value === null || value === undefined || value === '') return { value: null };
    if (typeof value !== 'string' || value.length > max) return { error: `${field} must be at most ${max} characters` };
    return { value: value.trim() };
}

function parsePhone(value) {
    const text = optionalText(value, 'Phone', 20);
    if (text.error || text.value === null) return text;
    return /^[0-9+()\s-]+$/.test(text.value) ? text : { error: 'Phone can only contain digits, spaces, +, - and parentheses' };
}

function parseNumber(value, field, { min = 0, max = 99999999.99, integer = false } = {}) {
    if (value === null || value === undefined || value === '') return { error: `${field} is required` };
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
        return { error: `${field} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}` };
    }
    return { value: integer ? number : Math.round(number * 100) / 100 };
}

function nameField(value, field, max) {
    const error = validateText(value, field, max);
    return error ? { error } : { value: value.trim() };
}

// Une los resultados de varios campos: devuelve el primer error o el objeto de valores
function collect(parts) {
    const values = {};
    for (const [key, result] of Object.entries(parts)) {
        if (result.error) return { error: result.error };
        values[key] = result.value;
    }
    return { values };
}

module.exports = { validateText, parseId, idOrNull, optionalText, parsePhone, parseNumber, nameField, collect };
