#!/usr/bin/env node
/* vsce names the artifact <name>-<version>.vsix on its own. The fork prefix is added here
   instead of in package.json, because a %VAR% form only expands in cmd.exe and a $VAR form
   only in POSIX shells — a Node script behaves the same on every platform. */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join('release', `deep-copilot-difred-${pkg.version}.vsix`);

fs.mkdirSync(path.join(root, 'release'), { recursive: true });

const win = process.platform === 'win32';
const vsce = path.join(root, 'node_modules', '.bin', win ? 'vsce.cmd' : 'vsce');
const res = spawnSync(vsce, ['package', '--out', out], {
  cwd: root,
  stdio: 'inherit',
  shell: win,
});

process.exit(res.status === null ? 1 : res.status);
