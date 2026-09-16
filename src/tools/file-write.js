// File-writing tools: write_file, str_replace_in_file, apply_patch.
// apply_patch is a self-contained unified-diff applicator — no npm dep.
'use strict';

const fs   = require('fs');
const path = require('path');

const { resolvePath }              = require('../utils/paths');
const { t }                        = require('../utils/strings');
const { truncate, ensurePathAllowed } = require('./utils');
const { readFileText, writeFileText } = require('../utils/encoding');

// ─── write_file ──────────────────────────────────────────────────────────────

async function toolWriteFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'write')) return t('blockedOutsideWs');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        writeFileText(fp, args.content, args.encoding);
        return `OK: wrote ${args.content.length} chars to ${args.path}`;
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── str_replace_in_file ─────────────────────────────────────────────────────

// Line offsets, so a mismatch can be reported by line number instead of as a
// bare "not found" that leaves the caller bisecting the block by hand.
function _lineIndex(text) {
    const offsets = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
    return offsets;
}

function _lineOf(offsets, idx) {
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo + 1; // 1-based
}

const _stripEol = (s) => s.replace(/[ \t]+$/, '');
const _trailLen = (s) => (_stripEol(s).length === s.length ? 0 : s.length - _stripEol(s).length);

// Whole-line comparison with trailing spaces and tabs dropped. Invisible
// trailing whitespace is the most common reason a retyped block fails to match,
// and an exact-only matcher turns that into a guessing loop. Used solely as a
// fallback when the exact search finds nothing, and reported as such.
function _findMatchesIgnoringTrailingSpace(text, oldStr) {
    const oldLines  = oldStr.split('\n');
    const textLines = text.split('\n');
    const offsets   = _lineIndex(text);
    const needle    = oldLines.map(_stripEol);
    const hits      = [];
    let prevEnd     = -1;
    for (let i = 0; i + oldLines.length <= textLines.length; i++) {
        let ok = true;
        for (let j = 0; j < oldLines.length; j++) {
            if (_stripEol(textLines[i + j]) !== needle[j]) { ok = false; break; }
        }
        if (!ok) continue;
        const last  = i + oldLines.length - 1;
        const start = offsets[i];
        const end   = offsets[last] + textLines[last].length;
        if (start < prevEnd) continue; // ignore overlapping hits
        prevEnd = end;
        hits.push({ start, end, loose: true });
        if (hits.length > 1000) break;
    }
    return hits;
}

function _collectMatches(text, oldStr) {
    const exact = [];
    for (let at = text.indexOf(oldStr); at !== -1; at = text.indexOf(oldStr, at + oldStr.length)) {
        exact.push({ start: at, end: at + oldStr.length, loose: false });
        if (exact.length > 1000) break;
    }
    return exact.length ? exact : _findMatchesIgnoringTrailingSpace(text, oldStr);
}

// Where the block went wrong: locate the closest place in the file and name the
// first line that differs, with both spellings quoted and the trailing-space
// counts when that is the whole difference.
function _describeMiss(text, oldStr) {
    const oldLines  = oldStr.split('\n');
    const textLines = text.split('\n');
    const anchor    = _stripEol(oldLines[0]).trim();
    if (!anchor) return '';
    const fileLine = textLines.findIndex(l => l.includes(anchor));
    if (fileLine < 0) {
        return `  The first line of old_string appears nowhere in the file: ${JSON.stringify(oldLines[0])}`
             + (anchor === oldLines[0]
                 ? '.'
                 : `\n  (also searched for it without trailing whitespace: ${JSON.stringify(anchor)}).`);
    }
    const fileNum = fileLine + 1;
    for (let j = 0; j < oldLines.length; j++) {
        const have = textLines[fileLine + j];
        if (have === undefined) {
            return `  Closest block starts at line ${fileNum}, but the file ends ${j} line(s) in,`
                 + ` short of the ${oldLines.length} line(s) in old_string.`;
        }
        if (have === oldLines[j]) continue;
        const spaceOnly = _stripEol(have) === _stripEol(oldLines[j]);
        return `  Closest block starts at line ${fileNum} (${j} of ${oldLines.length} line(s) matched).`
             + `\n  Line ${fileNum + j} differs${spaceOnly ? ' in trailing whitespace only' : ''}:`
             + `\n    old_string: ${JSON.stringify(oldLines[j])}`
             + `\n    file      : ${JSON.stringify(have)}`
             + (spaceOnly
                 ? `\n    (old_string ends with ${_trailLen(oldLines[j])} whitespace char(s), the file with ${_trailLen(have)}).`
                 : '');
    }
    return `  A block starting at line ${fileNum} already equals old_string.`;
}


async function toolStrReplaceInFile(args) {
    try {
        const fp = resolvePath(args.path);
        if (!await ensurePathAllowed(fp, 'write')) return t('blockedOutsideWs');
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        if (!oldStr) return 'Error: old_string is required and must not be empty.';
        const { text: rawText, encoding } = readFileText(fp);
        const expected = Math.max(1, Number(args.expected_replacements) || 1);

        // Normalise CRLF → LF for matching (same policy as apply_patch).
        // Both the file content and old_string are normalised so that
        // the agent never needs to guess the file's line-ending style.
        const hasCRLF = rawText.includes('\r\n');
        const text   = hasCRLF ? rawText.replace(/\r\n/g, '\n') : rawText;
        const oldStrNorm = hasCRLF ? oldStr.replace(/\r\n/g, '\n') : oldStr;

        const lineOffsets = _lineIndex(text);
        const matches = _collectMatches(text, oldStrNorm);
        if (matches.length === 0) {
            const why = _describeMiss(text, oldStrNorm);
            return `Error: old_string not found in ${args.path}.`
                 + (why ? `\n${why}` : '')
                 + `\n  Both sides are compared with LF line endings, so the remaining candidates are`
                 + ` indentation and whitespace inside the lines.`;
        }
        if (matches.length !== expected) {
            const lines = matches.map(m => _lineOf(lineOffsets, m.start));
            return `Error: old_string matched ${matches.length} time${matches.length === 1 ? '' : 's'} but expected_replacements=${expected}`
                 + ` (line${lines.length === 1 ? '' : 's'} ${lines.join(', ')}). To proceed, either include more`
                 + ` surrounding context to make old_string unique, or set expected_replacements=${matches.length} explicitly.`;
        }

        let updated = '';
        let cursor = 0;
        let loose = 0;
        for (const m of matches) {
            updated += text.slice(cursor, m.start) + newStr;
            cursor = m.end;
            if (m.loose) loose++;
        }
        updated += text.slice(cursor);

        writeFileText(fp, hasCRLF ? updated.replace(/\n/g, '\r\n') : updated, args.encoding || encoding);
        const note = loose ? ` — matched ${loose} block(s) ignoring trailing whitespace` : '';
        return `OK: ${matches.length} replacement(s) in ${args.path} (${updated.length - text.length >= 0 ? '+' : ''}${updated.length - text.length} chars)${note}.`;
    } catch (e) { return `Error: ${e.message}`; }
}

// ─── apply_patch (self-contained unified-diff applicator) ────────────────────

function _normalizeLines(text) {
    const hasCRLF = text.includes('\r\n');
    return { lines: text.replace(/\r\n/g, '\n').split('\n'), hasCRLF };
}

function _restoreEndings(lines, hasCRLF) {
    const joined = lines.join('\n');
    return hasCRLF ? joined.replace(/\n/g, '\r\n') : joined;
}

function _parsePatch(patchText) {
    const rawLines = patchText.replace(/\r\n/g, '\n').split('\n');
    const files = [];
    let cur = null, curHunk = null;
    for (const line of rawLines) {
        if (line.startsWith('--- ')) {
            cur = { oldPath: line.slice(4).trim().replace(/^a\//, ''), newPath: null, hunks: [] };
            curHunk = null;
        } else if (line.startsWith('+++ ') && cur) {
            cur.newPath = line.slice(4).trim().replace(/^b\//, '');
            files.push(cur);
        } else if (line.startsWith('@@ ') && cur) {
            const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (m) {
                curHunk = {
                    oldStart: parseInt(m[1], 10),
                    oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
                    newStart: parseInt(m[3], 10),
                    newCount: m[4] !== undefined ? parseInt(m[4], 10) : 1,
                    lines: [],
                };
                cur.hunks.push(curHunk);
            }
        } else if (curHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '')) {
            const prefix = line.length === 0 ? ' ' : line[0];
            const content = line.length === 0 ? '' : line.slice(1);
            if (prefix === '+' || prefix === '-' || prefix === ' ') curHunk.lines.push({ op: prefix, text: content });
        }
    }
    return files;
}

function _applyHunk(lines, hunk, fuzz = 0) {
    const contextAndRem = hunk.lines.filter(l => l.op === ' ' || l.op === '-').map(l => l.text);
    if (contextAndRem.length === 0 && hunk.oldCount === 0) {
        const insertAt = Math.max(0, Math.min(hunk.oldStart - 1 + fuzz, lines.length));
        const additions = hunk.lines.filter(l => l.op === '+').map(l => l.text);
        return { ok: true, lines: [...lines.slice(0, insertAt), ...additions, ...lines.slice(insertAt)] };
    }

    const anchorLine = hunk.oldStart - 1;
    const searchRadius = fuzz * 3 + 3;
    const searchStart = Math.max(0, anchorLine - searchRadius);
    const searchEnd   = Math.min(lines.length - contextAndRem.length, anchorLine + searchRadius);

    let bestMatch = -1, bestScore = -1;
    for (let start = searchStart; start <= searchEnd; start++) {
        let matches = 0;
        for (let i = 0; i < contextAndRem.length; i++) {
            const actual = lines[start + i] || '';
            const expected = contextAndRem[i];
            if (actual === expected) matches++;
            else if (fuzz > 0 && actual.trim() === expected.trim()) matches += 0.8;
        }
        const score = matches / Math.max(contextAndRem.length, 1);
        if (score > bestScore) { bestScore = score; bestMatch = start; }
    }

    const threshold = fuzz === 0 ? 1.0 : 0.75;
    if (bestScore < threshold) {
        return {
            ok: false,
            reason: `Could not find context at ~line ${hunk.oldStart} (best match score ${(bestScore * 100).toFixed(0)}%). ` +
                `Expected first context line: "${contextAndRem[0] || '(empty)'}". ` +
                `Actual lines ${hunk.oldStart - 1}–${hunk.oldStart + 2}: ` +
                lines.slice(Math.max(0, hunk.oldStart - 1), hunk.oldStart + 3).map(l => JSON.stringify(l)).join(', '),
        };
    }

    let pos = bestMatch;
    const result = [...lines.slice(0, pos)];
    for (const hl of hunk.lines) {
        if      (hl.op === ' ') result.push(lines[pos++]);
        else if (hl.op === '-') pos++;
        else if (hl.op === '+') result.push(hl.text);
    }
    result.push(...lines.slice(pos));
    return { ok: true, lines: result };
}

async function toolApplyPatch(args) {
    const patch = String(args.patch || '').trim();
    if (!patch) return 'Error: patch is empty.';

    let fileDiffs;
    try { fileDiffs = _parsePatch(patch); }
    catch (e) { return `Error: failed to parse patch — ${e.message}`; }
    if (fileDiffs.length === 0) return 'Error: patch parsed to 0 file diffs. Check the diff format.';

    const report = [];
    let anyFailed = false;

    for (const fileDiff of fileDiffs) {
        const relPath = (fileDiff.newPath && fileDiff.newPath !== '/dev/null')
            ? fileDiff.newPath : fileDiff.oldPath;
        const absPath = resolvePath(relPath);
        if (!await ensurePathAllowed(absPath, 'write')) {
            report.push(`❌ ${relPath}: denied (outside workspace)`);
            anyFailed = true; continue;
        }

        let originalText = '';
        let hasCRLF = false;
        let patchEncoding = 'utf8';
        const isNewFile = !fs.existsSync(absPath);
        if (!isNewFile) {
            try {
                const { text, encoding } = readFileText(absPath);
                originalText = text;
                patchEncoding = encoding;
            }
            catch (e) { report.push(`❌ ${relPath}: read error — ${e.message}`); anyFailed = true; continue; }
        }
        const norm = _normalizeLines(originalText);
        let lines = norm.lines; hasCRLF = norm.hasCRLF;
        if (lines.length > 0 && lines[lines.length - 1] === '' && originalText.endsWith('\n')) lines = lines.slice(0, -1);

        const hunkReports = [];
        let ok = true;
        for (let hi = 0; hi < fileDiff.hunks.length; hi++) {
            const hunk = fileDiff.hunks[hi];
            let result = _applyHunk(lines, hunk, 0);
            if (!result.ok) result = _applyHunk(lines, hunk, 1);
            if (!result.ok) result = _applyHunk(lines, hunk, 2);
            if (!result.ok) {
                hunkReports.push(`  Hunk ${hi + 1}/@@ -${hunk.oldStart},${hunk.oldCount}: ${result.reason}`);
                ok = false;
            } else {
                lines = result.lines;
                hunkReports.push(`  Hunk ${hi + 1}/@@ -${hunk.oldStart},${hunk.oldCount}: ✓`);
            }
        }

        if (!ok) {
            report.push(`❌ ${relPath}:`); report.push(...hunkReports);
            anyFailed = true; continue;
        }

        try {
            const parentDir = path.dirname(absPath);
            if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
            const trailingNewline = originalText.endsWith('\n') || isNewFile;
            let output = _restoreEndings(lines, hasCRLF);
            if (trailingNewline && !output.endsWith(hasCRLF ? '\r\n' : '\n')) output += hasCRLF ? '\r\n' : '\n';
            writeFileText(absPath, output, patchEncoding);
            report.push(`✓ ${relPath}: ${fileDiff.hunks.length} hunk(s) applied`);
            report.push(...hunkReports);
        } catch (e) { report.push(`❌ ${relPath}: write error — ${e.message}`); anyFailed = true; }
    }

    const okCount = report.filter(r => r.startsWith('✓')).length;
    const summary = anyFailed
        ? `apply_patch: ${fileDiffs.length - okCount} file(s) failed. See details:\n`
        : `apply_patch: ${fileDiffs.length} file(s) patched successfully.\n`;
    return summary + report.join('\n');
}

module.exports = { toolWriteFile, toolStrReplaceInFile, toolApplyPatch };
