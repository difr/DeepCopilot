// Readers for user-edited settings.
//
// `workspace.getConfiguration().get()` returns raw JSON from settings.json —
// the manifest's `type: "string"` is only a schema hint for the editor: it
// underlines a wrong type but does NOT coerce the value, so a hand-edited file
// can hand back a number, an object or null. Anything that is not a string is
// therefore treated as "not set" instead of crashing on `.trim()` or leaking
// '[object Object]' into an HTTP payload.
'use strict';

/** Coerce a setting value to a trimmed string; non-strings become ''. */
function str(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** Coerce a setting value to an array; non-arrays become []. */
function arr(value) {
    return Array.isArray(value) ? value : [];
}

/**
 * Coerce a setting value to a boolean; non-booleans become `fallback`.
 * Strings are deliberately NOT parsed: "false" is a wrong type for a boolean
 * setting, and silently honouring it would hide the mistake instead of
 * falling back to the documented default.
 */
function bool(value, fallback = true) {
    return typeof value === 'boolean' ? value : fallback;
}

module.exports = { str, arr, bool };
