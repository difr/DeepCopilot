'use strict';

/**
 * The `<ask>` block is a service marker in the model's reply, not HTML. The extension
 * intercepts it, renders a question panel under the message, and never shows the tags
 * themselves. Keeping the marker short keeps the prompt cheap and the gate simple.
 *
 *   <ask>[{"question":"...","type":"single","options":["A","B"],"allowCustom":true}]</ask>
 */

const OPEN = '<ask>';
const CLOSE = '</ask>';

// More than this and the panel becomes a form nobody finishes.
const MAX_QUESTIONS = 8;
// A question longer than this is a paragraph, not a caption.
const MAX_QUESTION_CHARS = 300;
// Options per question; the API-side limits are irrelevant here, readability is not.
const MAX_OPTIONS = 12;

/** True when `pos` falls inside a fenced code block, where a marker is an example, not a panel. */
function _inCodeFence(buf, pos) {
    const fences = (buf.slice(0, pos).match(/^```/gm) || []).length;
    return fences % 2 === 1;
}

/** The marker only counts at the start of a line: an <ask> inside inline code or in the
 *  middle of a sentence is text the user needs to read, not the start of a panel. */
function _findOpen(buf) {
    let from = 0;
    for (;;) {
        const idx = buf.indexOf(OPEN, from);
        if (idx < 0) return -1;
        if ((idx === 0 || buf[idx - 1] === '\n') && !_inCodeFence(buf, idx)) return idx;
        from = idx + 1;
    }
}

/**
 * Holds back the stream once `<ask>` appears, so the tag never reaches the webview and does
 * not flash as text before the panel replaces it. Also guards a marker split across deltas:
 * the last `OPEN.length - 1` characters are never emitted until they are known to be text.
 */
class AskGate {
    constructor() {
        this._buf = '';
        this._block = '';
        this._found = false;
        this._closed = false;
    }

    /** @returns {string} text that may be shown to the user right now */
    push(text) {
        this._buf += typeof text === 'string' ? text : '';
        let out = '';
        for (;;) {
            // After the closing tag everything is ordinary text again.
            if (this._closed) {
                out += this._buf;
                this._buf = '';
                break;
            }
            if (this._found) {
                const close = this._buf.indexOf(CLOSE);
                if (close < 0) break;
                this._block = this._buf.slice(0, close + CLOSE.length);
                this._buf = this._buf.slice(close + CLOSE.length);
                this._closed = true;
                continue;
            }
            const open = _findOpen(this._buf);
            if (open >= 0) {
                out += this._buf.slice(0, open);
                this._buf = this._buf.slice(open);
                this._found = true;
                continue;
            }
            const keep = OPEN.length - 1;
            if (this._buf.length > keep) {
                out += this._buf.slice(0, -keep);
                this._buf = this._buf.slice(-keep);
            }
            break;
        }
        return out;
    }

    /** @returns {{rest: string, block: string}} trailing text and the raw marker block */
    finish() {
        if (!this._found) {
            const rest = this._buf;
            this._buf = '';
            return { rest, block: '' };
        }
        if (!this._closed) {
            this._block = this._buf;
            this._buf = '';
        }
        const rest = this._buf;
        this._buf = '';
        return { rest, block: this._block };
    }
}

/**
 * Turns the raw marker block into questions, or null when it is not usable JSON.
 * Null is a normal outcome: the caller keeps the block as text (in a code fence) and the
 * turn continues — a badly formatted panel must never cost the user a reply.
 */
function parseAskBlock(raw) {
    if (typeof raw !== 'string') return null;
    const start = raw.indexOf(OPEN);
    if (start < 0) return null;
    const end = raw.indexOf(CLOSE, start + OPEN.length);
    const inner = raw.slice(start + OPEN.length, end >= 0 ? end : raw.length).trim();
    if (!inner) return null;

    let data;
    try {
        data = JSON.parse(inner);
    } catch {
        return null;
    }
    if (!Array.isArray(data)) return null;

    const questions = [];
    for (const item of data) {
        if (!item || typeof item !== 'object') continue;
        const question = typeof item.question === 'string' ? item.question.trim() : '';
        if (!question) continue;

        const rawType = String(item.type || '').toLowerCase();
        const type = (rawType === 'multi' || rawType === 'checkbox') ? 'multi'
            : (rawType === 'text' || rawType === 'input') ? 'text'
                : 'single';

        const options = Array.isArray(item.options)
            ? item.options
                .map(o => (typeof o === 'string' ? o : (o && typeof o.label === 'string' ? o.label : '')))
                .map(s => String(s).trim())
                .filter(Boolean)
                .slice(0, MAX_OPTIONS)
            : [];

        // A choice question with no choices can only be answered in free text.
        const effectiveType = type === 'text' || options.length ? type : 'text';

        questions.push({
            // Assigned by position: the model sends no id, and a duplicate from it would merge
            // two radio groups into one and make them share a single answer.
            id: `q${questions.length + 1}`,
            question: question.slice(0, MAX_QUESTION_CHARS),
            type: effectiveType,
            options: effectiveType === 'text' ? [] : options,
            allowCustom: item.allowCustom === true,
        });
        if (questions.length >= MAX_QUESTIONS) break;
    }

    return questions.length ? questions : null;
}

/** Keeps a broken block visible but readable: the tags go, the JSON stays in a code fence. */
function brokenBlockAsCode(raw) {
    const text = String(raw || '');
    const start = text.indexOf(OPEN);
    if (start < 0) return text;
    const end = text.indexOf(CLOSE, start + OPEN.length);
    const inner = text.slice(start + OPEN.length, end >= 0 ? end : text.length).trim();
    if (!inner) return '';
    return '```json\n' + inner + '\n```';
}

module.exports = {
    OPEN,
    CLOSE,
    MAX_QUESTIONS,
    AskGate,
    parseAskBlock,
    brokenBlockAsCode,
};
