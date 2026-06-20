// memory.js — Persistent project-level memory stored in .deep-copilot/memory.md.
// memory_read: read the whole file.
// memory_write: upsert a named section.
'use strict';

const fs   = require('fs');
const path = require('path');

const { wsRoot }   = require('../utils/paths');
const { truncate } = require('./utils');

function _memoryPath() {
    const root = wsRoot();
    if (!root) throw new Error('No workspace folder open.');
    return path.join(root, '.deep-copilot', 'memory.md');
}

/** Return the full contents of the project memory file. */
async function toolMemoryRead() {
    let p;
    try { p = _memoryPath(); } catch (e) { return `Error: ${e.message}`; }

    try {
        const content = fs.readFileSync(p, 'utf8');
        return truncate(content || '(memory file is empty)', 16000);
    } catch (e) {
        if (e.code === 'ENOENT') return '(No project memory yet. Use memory_write to add facts.)';
        return `Error: ${e.message}`;
    }
}

/**
 * Upsert a section in the project memory file.
 * args: { section: string, content: string }
 */
async function toolMemoryWrite(args) {
    if (!args || !args.section || !args.content)
        return 'Error: section and content are required.';

    let p;
    try { p = _memoryPath(); } catch (e) { return `Error: ${e.message}`; }

    // Ensure .deep-copilot/ directory exists
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* already exists */ }

    let existing = '';
    try { existing = fs.readFileSync(p, 'utf8'); } catch { /* file does not exist yet */ }

    const header   = `## ${args.section}`;
    const newBody  = String(args.content).trim();

    // Replace existing section if present, otherwise append
    let updated;
    if (existing) {
        const lines = existing.split('\n');
        let sectionStart = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === header) { sectionStart = i; break; }
        }

        if (sectionStart >= 0) {
            // Find next section header (or EOF)
            let sectionEnd = lines.length;
            for (let i = sectionStart + 1; i < lines.length; i++) {
                if (/^## /.test(lines[i])) { sectionEnd = i; break; }
            }
            // Remove old body
            lines.splice(sectionStart + 1, sectionEnd - sectionStart - 1);
            // Insert new content with blank-line separator
            const insert = ['', newBody];
            if (sectionEnd < lines.length) insert.push(''); // trailing blank before next section
            lines.splice(sectionStart + 1, 0, ...insert);
            updated = lines.join('\n');
        } else {
            const base = existing.trimEnd();
            updated = (base ? base + '\n\n' : '# Project Memory\n\n') + header + '\n\n' + newBody + '\n';
        }
    } else {
        updated = '# Project Memory\n\n' + header + '\n\n' + newBody + '\n';
    }

    try {
        fs.writeFileSync(p, updated, 'utf8');
        const root = wsRoot();
        const rel  = root ? path.relative(root, p).replace(/\\/g, '/') : p;
        return `Memory section "${args.section}" saved to ${rel}.`;
    } catch (e) {
        return `Error: ${e.message}`;
    }
}

module.exports = { toolMemoryRead, toolMemoryWrite };
