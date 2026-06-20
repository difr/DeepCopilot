// Миграция сессий DeepCopilot из marketplace-версии в кастомную сборку.
// Запуск:  node scripts/migrate-sessions.mjs
// Требуется Node.js 22+ (встроенный модуль node:sqlite).
//
// Сессии мерджатся по id (кастомные побеждают при конфликте),
// скалярные ключи копируются, только если их ещё нет в кастомной версии.
'use strict';

import { DatabaseSync } from 'node:sqlite';

const DB  = 'C:/Programs/VSCode/data/user-data/User/globalStorage/state.vscdb';
const OLD = 'ZhouChaunge.deep-copilot';
const NEW = 'difr.deep-copilot';

const SCALAR_KEYS = [
    'deepseekAgent.keyPrompted',
    'deepseekAgent.archiveSemanticsV2Migrated',
    'deepseekAgent.discountWarnShown',
];

const db = new DatabaseSync(DB);

// ── Читаем ────────────────────────────────────────────────────────────────
const oldRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(OLD);
if (!oldRow) {
    console.log('Старая запись не найдена — нечего мигрировать.');
    db.close();
    process.exit(0);
}
const oldVal = JSON.parse(oldRow.value.toString('utf8'));

const newRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(NEW);
const newVal = newRow ? JSON.parse(newRow.value.toString('utf8')) : {};

const stats = { merged: 0, skipped: 0, scalar: 0 };
const mergedSessions = [];
const skippedSessions = [];

// ── Сессии: мердж по id ──────────────────────────────────────────────────
const oldSessions = oldVal['deepseekAgent.sessions'];
if (Array.isArray(oldSessions) && oldSessions.length > 0) {
    const existing = newVal['deepseekAgent.sessions'];
    const existingIds = new Set(
        Array.isArray(existing) ? existing.map(s => s.id) : []
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

    // Мерж: старые в конец, кастомные впереди
    const base = Array.isArray(existing) ? existing : [];
    newVal['deepseekAgent.sessions'] = [...base, ...mergedSessions];
} else {
    console.log('  В старой версии нет сессий.');
}

// ── Скалярные ключи ───────────────────────────────────────────────────────
for (const k of SCALAR_KEYS) {
    if (oldVal[k] !== undefined && newVal[k] === undefined) {
        newVal[k] = oldVal[k];
        stats.scalar++;
    }
}

// ── Пишем ─────────────────────────────────────────────────────────────────
db.prepare('INSERT OR REPLACE INTO ItemTable(key, value) VALUES(?, ?)')
    .run(NEW, JSON.stringify(newVal));

// ── Отчёт ─────────────────────────────────────────────────────────────────
const total = newVal['deepseekAgent.sessions']?.length || 0;
console.log(`\nРезультат:`);
console.log(`  Добавлено сессий:  ${stats.merged}`);
console.log(`  Пропущено (уже были): ${stats.skipped}`);
console.log(`  Скалярных ключей:  ${stats.scalar}`);
console.log(`  Всего после миграции: ${total}`);

if (mergedSessions.length > 0) {
    console.log('\nДобавленные:');
    for (const s of mergedSessions) {
        console.log(`  + ${s.id}  ${(s.title || '').substring(0, 70)}`);
    }
}
if (skippedSessions.length > 0) {
    console.log('\nПропущенные (уже были в кастомной):');
    for (const s of skippedSessions) {
        console.log(`  ~ ${s.id}  ${(s.title || '').substring(0, 70)}`);
    }
}

db.close();
console.log('\nГотово. Перезапусти VS Code.');
