// Build timestamp of the running bundle.
'use strict';

/* esbuild rewrites out/extension.js on every `npm run build`, so its mtime answers "which
   build is running" — package.json only carries the version, and an installed copy keeps
   whatever mtime the installer gave it. Resolved at call time so the value never goes stale
   inside a long-lived host process. */
function buildTime() {
    try {
        return require('fs').statSync(__filename).mtime.toISOString().slice(0, 19).replace('T', ' ');
    } catch (e) {
        return '';
    }
}

module.exports = { buildTime };
