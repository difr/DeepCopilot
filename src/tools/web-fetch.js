// web_fetch: fetches a URL and returns the page content as plain text.
// Safety design:
//   - blocks private/internal IPs (SSRF protection)
//   - forbids cross-host redirects (open-redirect protection)
//   - 2MB content cap, 30s timeout
//   - over-long results are truncated to save tokens
'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { truncate } = require('./utils');

// ─── Private-network guard (SSRF protection) ─────────────────────────────────
const BLOCKED_PATTERNS = [
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[01])\./,
    /^169\.254\./,   // link-local
    /^::1$/,         // IPv6 localhost
    /^fc00:/i,       // IPv6 private
    /^localhost$/i,
    /^metadata\.google\.internal$/i,
    /^169\.254\.169\.254$/,  // AWS/GCP metadata
];

function isBlockedHost(hostname) {
    return BLOCKED_PATTERNS.some(re => re.test(hostname));
}

// ─── URL validation ──────────────────────────────────────────────────────────
function validateUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { return { ok: false, reason: `Invalid URL: ${rawUrl}` }; }

    if (!['http:', 'https:'].includes(parsed.protocol))
        return { ok: false, reason: `Unsupported protocol ${parsed.protocol} — only http/https are allowed` };

    if (parsed.username || parsed.password)
        return { ok: false, reason: 'URLs with embedded credentials are not allowed' };

    if (isBlockedHost(parsed.hostname))
        return { ok: false, reason: `Private-network address blocked: ${parsed.hostname}` };

    return { ok: true, parsed };
}

// ─── Core fetch (redirects handled manually, cross-host hops rejected) ───────
const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2MB
const FETCH_TIMEOUT_MS  = 30_000;
const MAX_REDIRECTS     = 5;

function fetchUrl(rawUrl, redirectsLeft = MAX_REDIRECTS, abortSignal = null) {
    return new Promise((resolve, reject) => {
        const check = validateUrl(rawUrl);
        if (!check.ok) return reject(new Error(check.reason));

        if (abortSignal && abortSignal.aborted) return reject(new Error('aborted'));

        const { parsed } = check;
        // Force HTTPS.
        const finalUrl = parsed.protocol === 'http:'
            ? rawUrl.replace(/^http:/, 'https:')
            : rawUrl;

        const lib = finalUrl.startsWith('https:') ? https : http;

        let onAbort = null;

        const req = lib.get(finalUrl, {
            timeout: FETCH_TIMEOUT_MS,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; DeepCopilot/1.0; +https://github.com)',
                'Accept':     'text/html,text/plain,*/*',
            },
            // maxRedirects=0 — we handle redirects ourselves.
        }, (res) => {
            // Handle redirects.
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                if (!location) return reject(new Error('Redirect is missing the Location header'));
                if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));

                // Resolve relative URLs.
                let redirectUrl;
                try { redirectUrl = new URL(location, finalUrl).toString(); }
                catch { return reject(new Error(`Invalid redirect target: ${location}`)); }

                // Same-host redirects only (compared with the `www.` prefix stripped).
                const strip = h => h.replace(/^www\./, '');
                const origHost = new URL(finalUrl).hostname;
                const redirHost = new URL(redirectUrl).hostname;
                if (strip(origHost) !== strip(redirHost)) {
                    return reject(new Error(
                        `Cross-host redirect blocked: ${origHost} → ${redirHost}\n` +
                        `To fetch the target instead, call web_fetch directly with: ${redirectUrl}`
                    ));
                }

                res.destroy();
                return fetchUrl(redirectUrl, redirectsLeft - 1, abortSignal).then(resolve, reject);
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.destroy();
                return reject(new Error(`HTTP ${res.statusCode}: ${finalUrl}`));
            }

            // Read the body, enforcing the size cap.
            const chunks = [];
            let totalBytes = 0;
            res.on('data', chunk => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_CONTENT_BYTES) {
                    res.destroy();
                    // Do not reject — return what we already collected (truncated).
                    resolve({ body: Buffer.concat(chunks).toString('utf8'), truncated: true, url: finalUrl, status: res.statusCode, contentType: res.headers['content-type'] || '' });
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                resolve({
                    body: Buffer.concat(chunks).toString('utf8'),
                    truncated: false,
                    url: finalUrl,
                    status: res.statusCode,
                    contentType: res.headers['content-type'] || '',
                });
            });
            res.on('error', reject);
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error(`Request timed out (${FETCH_TIMEOUT_MS}ms): ${finalUrl}`));
        });

        if (abortSignal) {
            onAbort = () => { try { req.destroy(new Error('aborted')); } catch {} reject(new Error('aborted')); };
            if (abortSignal.aborted) { onAbort(); return; }
            abortSignal.addEventListener('abort', onAbort, { once: true });
            // Best-effort: clear listener when promise settles
            const cleanup = () => { try { abortSignal.removeEventListener('abort', onAbort); } catch {} };
            req.once('close', cleanup);
        }
    });
}

// ─── HTML → plain text (simple, dependency-free) ─────────────────────────────
function htmlToText(html) {
    return html
        // Drop <script> / <style> blocks.
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        // Turn common block-level tags into newlines.
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
        // Strip every remaining HTML tag.
        .replace(/<[^>]+>/g, '')
        // Decode common HTML entities.
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        // Collapse runs of blank lines.
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── Tool entry points ───────────────────────────────────────────────────────

// Structured variant: no "Error:" prefix sniffing — for callers (context-refs
// and friends) that need to tell success from failure. Returns { ok, body?, error? }.
async function fetchAndExtractText(args, _ctx = {}) {
    const url = String((args && args.url) || '').trim();
    if (!url) return { ok: false, error: 'url is required' };

    const { ok, reason } = validateUrl(url);
    if (!ok) return { ok: false, error: reason };

    const abortSignal = _ctx && _ctx.abortSignal;
    if (abortSignal && abortSignal.aborted) return { ok: false, error: 'aborted' };

    try {
        const { body, truncated, url: finalUrl, status, contentType } = await fetchUrl(url, MAX_REDIRECTS, abortSignal);
        const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
        const text   = isHtml ? htmlToText(body) : body;
        const header = `URL: ${finalUrl}\nHTTP status: ${status}\nContent-Type: ${contentType}${truncated ? '\n⚠️ content truncated (over 2MB)' : ''}\n\n`;
        return { ok: true, body: truncate(header + text), finalUrl, status, contentType };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

// String variant: keeps the tool-call contract unchanged (the agent loop expects a string).
async function toolWebFetch(args, _ctx = {}) {
    const res = await fetchAndExtractText(args, _ctx);
    if (!res.ok) return `Error: ${res.error}`;
    return res.body;
}

module.exports = { toolWebFetch, fetchAndExtractText };
