// diff-files.js — Compare two files or directories (unified diff).
// Uses `git diff --no-index` (execFile, not shell) — works outside git repos.
'use strict';

const cp   = require('child_process');
const fs   = require('fs');
const path = require('path');

const { wsRoot, resolvePath } = require('../utils/paths');
const { t }                   = require('../utils/i18n');
const { truncate, ensurePathAllowed } = require('./utils');

const MAX_OUTPUT = 24000;
const MAX_FILES  = 20;

function runGit(args, cwd) {
  return new Promise(resolve => {
    cp.execFile('git', args, { cwd, maxBuffer: 1024 * 512, timeout: 15000 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        resolve({ ok: false, output: stderr || err.message });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}

function isBinary(fp) {
  try {
    const buf = fs.readFileSync(fp);
    const lim = Math.min(buf.length, 8192);
    for (let i = 0; i < lim; i++) if (buf[i] === 0) return true;
    return false;
  } catch { return false; }
}

async function toolDiffFiles(args) {
  try {
    const a = resolvePath(args.path_a);
    const b = resolvePath(args.path_b);
    if (!await ensurePathAllowed(a, 'read')) return t('blockedOutsideWs');
    if (!await ensurePathAllowed(b, 'read')) return t('blockedOutsideWs');

    let statA, statB;
    try { statA = fs.statSync(a); } catch { return `Error: path_a not found: ${args.path_a}`; }
    try { statB = fs.statSync(b); } catch { return `Error: path_b not found: ${args.path_b}`; }

    const maxFiles = Math.min(MAX_FILES, Math.max(1, Number(args.max_files) || MAX_FILES));
    const cwd = wsRoot() || process.cwd();

    // Both are files
    if (statA.isFile() && statB.isFile()) {
      if (isBinary(a) || isBinary(b)) {
        const same = fs.readFileSync(a).equals(fs.readFileSync(b));
        return same ? '(files are identical)' : '[binary files differ]';
      }
      const { ok, output } = await runGit(['diff', '--no-index', '--', a, b], cwd);
      if (!ok) return `Error: ${output}`;
      return truncate(output.trim() || '(files are identical)', MAX_OUTPUT);
    }

    // One file, one directory: diff the file against its counterpart in the dir
    if (statA.isFile() !== statB.isFile()) {
      const filePath = statA.isFile() ? a : b;
      const dirPath  = statA.isDirectory() ? a : b;
      const aRoot = statA.isDirectory() ? a : path.dirname(a);
      const bRoot = statB.isDirectory() ? b : path.dirname(b);
      const rel = path.relative(statA.isFile() ? aRoot : bRoot, filePath);
      const other = path.join(dirPath, rel);
      if (!fs.existsSync(other)) return `--- ${rel} (only in one tree) ---`;
      if (isBinary(filePath) || isBinary(other)) {
        const same = fs.readFileSync(filePath).equals(fs.readFileSync(other));
        return same ? '(files are identical)' : `[binary files differ] in ${rel}`;
      }
      const { ok, output } = await runGit(['diff', '--no-index', '--',
        statA.isFile() ? a : other, statB.isFile() ? b : other], cwd);
      if (!ok) return `Error: ${output}`;
      return truncate(output.trim() || '(files are identical)', MAX_OUTPUT);
    }

    // Both are directories — use --stat for a compact summary
    const { ok: statOk, output: statOut } = await runGit(
      ['diff', '--no-index', '--stat', '--', a, b], cwd);
    if (!statOk) return `Error: ${statOut}`;

    const lines = statOut.trim().split(/\r?\n/);
    if (!lines.length || (lines.length === 1 && !lines[0])) return '(directories are identical)';

    // Last line is the summary (e.g. "5 files changed, 20 insertions(+), 3 deletions(-)")
    // Everything before is per-file stats
    const summary = lines.pop();
    const statLines = lines;

    const total = statLines.length;
    const capped = statLines.slice(0, maxFiles);
    const out = [`${total} file(s) differ:`];
    for (const l of capped) out.push(l);

    if (total > maxFiles) {
      out.push(`... (${total - maxFiles} more files not shown. Use max_files to increase.)`);
    }
    out.push(summary);

    return truncate(out.join('\n'), MAX_OUTPUT);
  } catch (e) {
    if (e.code === 'ENOENT') return 'Error: git not found. diff_files requires git to be installed.';
    return `Error: ${e.message}`;
  }
}

module.exports = { toolDiffFiles };
