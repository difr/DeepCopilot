// Project-level file-encoding resolver.
// Reads deepseekAgent.fileEncoding settings (flat glob→encoding map + optional "*" key for default),
// applies them on every file read/write so non-UTF-8 projects work correctly.
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

// ── iconv-lite (optional — only load when a non-UTF-8 encoding is needed) ──
let _iconv = undefined;
function _getIconv() {
    if (_iconv === undefined) {
        try { _iconv = require('iconv-lite'); }
        catch { _iconv = null; }
    }
    return _iconv;
}

// ── Config access ────────────────────────────────────────────────────────────

function _getConfig() {
    try {
        return vscode.workspace.getConfiguration('deepseekAgent').get('fileEncoding') || {};
    } catch { return {}; }
}

// ── Workspace root (for relative-path glob matching) ─────────────────────────

function _wsRoot() {
    try {
        const folder = (vscode.workspace.workspaceFolders || [])[0];
        return folder ? folder.uri.fsPath : process.cwd();
    } catch { return process.cwd(); }
}

// ── Glob matching (minimal — **, *, ?) ───────────────────────────────────────

function _globToRegex(pattern) {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                re += '.*';
                i++;
                if (pattern[i + 1] === '/') i++;
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else if ('.+^${}()|[]\\'.indexOf(c) !== -1) {
            re += '\\' + c;
        } else {
            re += c;
        }
    }
    return new RegExp('^' + re + '$');
}

// ── Encoding normalisation (aliases → canonical names iconv-lite understands) ─

function _normalize(enc) {
    enc = (enc || '').toLowerCase().replace(/[_-]/g, '');
    const aliases = {
        'utf8bom':     'utf8',
        'win1251':     'cp1251',
        'windows1251': 'cp1251',
        'ibm866':      'cp866',
        'iso88591':    'latin1',
        'koi8r':       'koi8-r',
        'koi8u':       'koi8-u',
    };
    return aliases[enc] || enc;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the encoding for an absolute file path from project config only.
 * Priority:
 *   1. Longest-matching glob pattern in config
 *   2. "*" key in config (project-wide default)
 *   3. files.encoding VS Code setting
 *   4. 'utf8' (ultimate fallback)
 *
 * @param {string} filePath  absolute file path
 * @returns {string} canonical encoding name
 */
function resolveEncoding(filePath) {
    const cfg = _getConfig();
    // Keys are glob patterns, value is encoding.
    // The "*" key (reserved — invalid filename on all OSes) sets the project default.
    // Example: {"*": "utf8", "trunk/**/*": "cp1251", "src/**/*.pas": "cp866"}

    // 1. Glob overrides — sort by pattern specificity (length descending)
    const ws = _wsRoot();
    const rel = path.relative(ws, filePath).replace(/\\/g, '/');
    const patterns = Object.keys(cfg)
        .filter(k => k !== '*')
        .sort((a, b) => b.length - a.length);
    for (const pat of patterns) {
        if (_globToRegex(pat).test(rel)) return _normalize(cfg[pat]);
    }

    // 2. Project default
    if (cfg['*']) return _normalize(cfg['*']);

    // 3. VS Code setting
    try {
        const vsEnc = vscode.workspace.getConfiguration('files').get('encoding');
        if (vsEnc) return _normalize(vsEnc);
    } catch {}

    // 4. Fallback
    return 'utf8';
}

/**
 * Read a file with the correct encoding.
 * @returns {{ text: string, encoding: string, size: number }}
 */
function readFileText(filePath) {
    const buf = fs.readFileSync(filePath);
    const enc = resolveEncoding(filePath);
    const text = decodeBuf(buf, enc);
    return { text, encoding: enc, size: buf.length };
}

/**
 * Write a file preserving or applying the given encoding.
 * @param {string} filePath
 * @param {string} text
 * @param {string} [encoding] — if omitted, resolved from config for the path
 */
function writeFileText(filePath, text, encoding) {
    const enc = encoding ? _normalize(encoding) : resolveEncoding(filePath);
    const buf = encodeText(text, enc);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
}

/**
 * Decode a Buffer to string.
 */
function decodeBuf(buf, enc, normalizeEnc) {
    if (normalizeEnc) enc = _normalize(enc);
    if (enc === 'utf8' || enc === 'utf16le') {
        if (enc === 'utf8' && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
        return buf.toString(enc);
    }
    const iconv = _getIconv();
    if (iconv) {
        try { return iconv.decode(buf, enc); }
        catch { /* fall through */ }
    }
    try { return buf.toString(enc); }
    catch { return buf.toString('latin1'); }
}

/**
 * Encode a string to Buffer.
 */
function encodeText(text, enc, normalizeEnc) {
    if (normalizeEnc) enc = _normalize(enc);
    if (enc === 'utf8' || enc === 'utf16le') {
        return Buffer.from(text, enc);
    }
    const iconv = _getIconv();
    if (iconv) {
        try { return iconv.encode(text, enc); }
        catch { /* fall through */ }
    }
    try { return Buffer.from(text, enc); }
    catch { return Buffer.from(text, 'latin1'); }
}

/**
 * Create a Readable stream for the file decoded with the correct encoding.
 * Returns { stream, encoding } — consumer pipes the stream into readline etc.
 */
function createDecodedStream(filePath) {
    const enc = resolveEncoding(filePath);
    if (enc === 'utf8' || enc === 'utf16le') {
        return { stream: fs.createReadStream(filePath, { encoding: enc }), encoding: enc };
    }
    const iconv = _getIconv();
    if (iconv) {
        try {
            const ds = iconv.decodeStream(enc);
            return { stream: fs.createReadStream(filePath).pipe(ds), encoding: enc };
        } catch { /* fall through */ }
    }
    try {
        return { stream: fs.createReadStream(filePath, { encoding: enc }), encoding: enc };
    } catch {
        return { stream: fs.createReadStream(filePath, { encoding: 'latin1' }), encoding: 'latin1' };
    }
}

module.exports = { resolveEncoding, readFileText, writeFileText, decodeBuf, encodeText, createDecodedStream };
