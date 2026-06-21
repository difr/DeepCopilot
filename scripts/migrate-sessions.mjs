// Migrate DeepCopilot sessions between extension identities.
//
// Usage:
//   node scripts/migrate-sessions.mjs
//   node scripts/migrate-sessions.mjs --from old.publisher.ext --to new.publisher.ext
//   node scripts/migrate-sessions.mjs --db /path/to/state.vscdb --from X --to Y
//
// Requires Node.js 22+ (built-in node:sqlite).
//
// Sessions are merged by id (newer identity wins on conflict),
// scalar keys are copied only if missing in the target.
'use strict';

import { DatabaseSync } from 'node:sqlite';
import { existsSync }          from 'node:fs';
import { homedir, platform }   from 'node:os';
import { join }                from 'node:path';

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS = {
    from: 'ZhouChaunge.deep-copilot',
    to:   'difr.deep-copilot',
};

const SCALAR_KEYS = [
    'deepseekAgent.keyPrompted',
    'deepseekAgent.archiveSemanticsV2Migrated',
    'deepseekAgent.discountWarnShown',
];

// ── Auto-detect state.vscdb path ──────────────────────────────────────────

function resolveDbPath() {
    const home = homedir();
    const candidates = [];

    if (platform() === 'win32') {
        const appData = process.env.APPDATA;
        if (appData) candidates.push(join(appData, 'Code', 'User', 'globalStorage', 'state.vscdb'));
        if (process.env.LOCALAPPDATA) {
            candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'VSCode', 'data', 'user-data', 'User', 'globalStorage', 'state.vscdb'));
        }
        // Portable / custom install
        candidates.push('C:/Programs/VSCode/data/user-data/User/globalStorage/state.vscdb');
    } else if (platform() === 'darwin') {
        candidates.push(join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb'));
    } else {
        candidates.push(join(home, '.config', 'Code', 'User', 'globalStorage', 'state.vscdb'));
    }

    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return null;
}

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { ...DEFAULTS, db: null };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--from' && i + 1 < args.length) opts.from = args[++i];
        else if (args[i] === '--to'   && i + 1 < args.length) opts.to   = args[++i];
        else if (args[i] === '--db'   && i + 1 < args.length) opts.db   = args[++i];
        else if (args[i] === '--help' || args[i] === '-h') {
            console.log('Usage: node scripts/migrate-sessions.mjs [--from <id>] [--to <id>] [--db <path>]');
            console.log(`  --from   Source extension id (default: ${DEFAULTS.from})`);
            console.log(`  --to     Target extension id (default: ${DEFAULTS.to})`);
            console.log('  --db     Path to state.vscdb (default: auto-detect)');
            process.exit(0);
        }
    }
    if (!opts.db) opts.db = resolveDbPath();
    return opts;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
    const { from, to, db: dbPath } = parseArgs();

    if (!dbPath) {
        console.error('Error: could not find state.vscdb. Use --db to specify the path.');
        process.exit(1);
    }
    if (!existsSync(dbPath)) {
        console.error(`Error: state.vscdb not found at ${dbPath}`);
        process.exit(1);
    }

    console.log(`Source:      ${from}`);
    console.log(`Target:      ${to}`);
    console.log(`Database:    ${dbPath}\n`);

    const db = new DatabaseSync(dbPath);

    // ── Read ──────────────────────────────────────────────────────────────
    const oldRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(from);
    if (!oldRow) {
        console.log('Old extension data not found — nothing to migrate.');
        db.close();
        process.exit(0);
    }
    const oldVal = JSON.parse(oldRow.value.toString('utf8'));

    const newRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(to);
    const newVal = newRow ? JSON.parse(newRow.value.toString('utf8')) : {};

    const stats = { merged: 0, skipped: 0, scalar: 0 };
    const mergedSessions = [];
    const skippedSessions = [];

    // ── Sessions: merge by id ─────────────────────────────────────────────
    const oldSessions = oldVal['deepseekAgent.sessions'];
    if (Array.isArray(oldSessions) && oldSessions.length > 0) {
        const existing = newVal['deepseekAgent.sessions'];
        const existingIds = new Set(
            Array.isArray(existing) ? existing.map(s => s.id) : [],
        );

        for (const s of oldSessions) {
            if (existingIds.has(s.id)) {
                skippedSessions.push(s);
                stats.skipped++;
            } else {
                mergedSessions.push(s);
                stats.merged++;
            }
        }

        const base = Array.isArray(existing) ? existing : [];
        newVal['deepseekAgent.sessions'] = [...base, ...mergedSessions];
    } else {
        console.log('  No sessions in the old extension.');
    }

    // ── Scalar keys ───────────────────────────────────────────────────────
    for (const k of SCALAR_KEYS) {
        if (oldVal[k] !== undefined && newVal[k] === undefined) {
            newVal[k] = oldVal[k];
            stats.scalar++;
        }
    }

    // ── Write ─────────────────────────────────────────────────────────────
    db.prepare('INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)')
        .run(to, JSON.stringify(newVal));

    // ── Report ────────────────────────────────────────────────────────────
    const total = newVal['deepseekAgent.sessions']?.length || 0;
    console.log('Result:');
    console.log(`  Sessions merged:      ${stats.merged}`);
    console.log(`  Skipped (duplicates): ${stats.skipped}`);
    console.log(`  Scalar keys copied:   ${stats.scalar}`);
    console.log(`  Total after merge:    ${total}`);

    if (mergedSessions.length > 0) {
        console.log('\nMerged:');
        for (const s of mergedSessions) {
            console.log(`  + ${s.id}  ${(s.title || '').substring(0, 70)}`);
        }
    }
    if (skippedSessions.length > 0) {
        console.log('\nSkipped (already present):');
        for (const s of skippedSessions) {
            console.log(`  ~ ${s.id}  ${(s.title || '').substring(0, 70)}`);
        }
    }

    db.close();
    console.log('\nDone. Restart VS Code.');
}

main();
