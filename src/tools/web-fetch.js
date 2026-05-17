// web_fetch: 抓取指定 URL 的网页内容，转成纯文本返回给模型。
// 安全设计：
//   - 拦截内网/私有 IP（防 SSRF）
//   - 禁止跨主机重定向（防开放重定向攻击）
//   - 内容大小上限 2MB，超时 30 秒
//   - 结果超长自动截断，省 token
'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');
const { truncate } = require('./utils');

// ─── 内网地址拦截（防 SSRF） ──────────────────────────────────────────────────
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

// ─── URL 合法性校验 ────────────────────────────────────────────────────────────
function validateUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { return { ok: false, reason: `无效的 URL: ${rawUrl}` }; }

    if (!['http:', 'https:'].includes(parsed.protocol))
        return { ok: false, reason: `不支持的协议 ${parsed.protocol}，只支持 http/https` };

    if (parsed.username || parsed.password)
        return { ok: false, reason: '不允许 URL 中包含用户名/密码' };

    if (isBlockedHost(parsed.hostname))
        return { ok: false, reason: `禁止访问内网地址: ${parsed.hostname}` };

    return { ok: true, parsed };
}

// ─── 核心抓取（手动控制重定向，防跨域跳转） ────────────────────────────────────
const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2MB
const FETCH_TIMEOUT_MS  = 30_000;
const MAX_REDIRECTS     = 5;

function fetchUrl(rawUrl, redirectsLeft = MAX_REDIRECTS, abortSignal = null) {
    return new Promise((resolve, reject) => {
        const check = validateUrl(rawUrl);
        if (!check.ok) return reject(new Error(check.reason));

        if (abortSignal && abortSignal.aborted) return reject(new Error('aborted'));

        const { parsed } = check;
        // 强制升级到 HTTPS
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
            // 关键：maxRedirects=0，我们自己处理重定向
        }, (res) => {
            // 处理重定向
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                if (!location) return reject(new Error('重定向缺少 Location header'));
                if (redirectsLeft <= 0) return reject(new Error('重定向次数超过上限'));

                // 解析相对 URL
                let redirectUrl;
                try { redirectUrl = new URL(location, finalUrl).toString(); }
                catch { return reject(new Error(`无效的重定向地址: ${location}`)); }

                // 只允许同主机重定向（去掉 www 前缀后对比）
                const strip = h => h.replace(/^www\./, '');
                const origHost = new URL(finalUrl).hostname;
                const redirHost = new URL(redirectUrl).hostname;
                if (strip(origHost) !== strip(redirHost)) {
                    return reject(new Error(
                        `跨域重定向被拦截: ${origHost} → ${redirHost}\n` +
                        `如需访问目标地址，请直接用该 URL 调用 web_fetch: ${redirectUrl}`
                    ));
                }

                res.destroy();
                return fetchUrl(redirectUrl, redirectsLeft - 1, abortSignal).then(resolve, reject);
            }

            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.destroy();
                return reject(new Error(`HTTP ${res.statusCode}: ${finalUrl}`));
            }

            // 读取响应体，限制大小
            const chunks = [];
            let totalBytes = 0;
            res.on('data', chunk => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_CONTENT_BYTES) {
                    res.destroy();
                    // 不 reject，返回已收集部分（截断）
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
            req.destroy(new Error(`请求超时 (${FETCH_TIMEOUT_MS}ms): ${finalUrl}`));
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

// ─── HTML → 纯文本（简单版，不依赖第三方库） ───────────────────────────────────
function htmlToText(html) {
    return html
        // 去掉 <script> / <style> 块
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        // 把常见块级标签换成换行
        .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, '\n')
        // 去掉所有剩余 HTML 标签
        .replace(/<[^>]+>/g, '')
        // 解码常见 HTML 实体
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        // 合并多余空行
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── 工具主函数 ────────────────────────────────────────────────────────────────

// 结构化版本：不依赖 "Error:" 前缀字符串嗅探，供 context-refs 等需要
// 判别成功/失败的调用方使用。返回 { ok, body?, error? }。
async function fetchAndExtractText(args, _ctx = {}) {
    const url = String((args && args.url) || '').trim();
    if (!url) return { ok: false, error: 'url 不能为空' };

    const { ok, reason } = validateUrl(url);
    if (!ok) return { ok: false, error: reason };

    const abortSignal = _ctx && _ctx.abortSignal;
    if (abortSignal && abortSignal.aborted) return { ok: false, error: 'aborted' };

    try {
        const { body, truncated, url: finalUrl, status, contentType } = await fetchUrl(url, MAX_REDIRECTS, abortSignal);
        const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
        const text   = isHtml ? htmlToText(body) : body;
        const header = `URL: ${finalUrl}\nHTTP 状态: ${status}\n内容类型: ${contentType}${truncated ? '\n⚠️ 内容已截断（超过 2MB）' : ''}\n\n`;
        return { ok: true, body: truncate(header + text), finalUrl, status, contentType };
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
}

// 字符串版本：保持工具调用契约不变（agent loop 期望字符串）。
async function toolWebFetch(args, _ctx = {}) {
    const res = await fetchAndExtractText(args, _ctx);
    if (!res.ok) return `Error: ${res.error}`;
    return res.body;
}

module.exports = { toolWebFetch, fetchAndExtractText };
