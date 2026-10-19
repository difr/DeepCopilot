# Deep Copilot (difred) v1.2.0

**Topic: DeepSeek web search, and compaction that cuts once**

> Third release of the **difred** fork. Two themes. Web search now runs on DeepSeek's own
> Search and Fetch endpoints — same key, richer answers, a fraction of a cent per search —
> with DuckDuckGo and Bing kept as free fallbacks. And compaction stopped nibbling: the
> passes that rewrote the middle of the history for a small win are gone, because every
> byte they touched cost a cache miss.

### 🔎 1. Web search runs on DeepSeek

**Search and Fetch are plain REST calls on the key you already have.**
`POST /v1/tools/search` returns a 600-800 character summary written for a model to read,
plus a rerank score, an authority grade and a publication date; `POST /v1/tools/fetch`
returns a page as Markdown. Neither is a tool definition, so neither changes the shape of
a chat request. Price is 5 CNY per 1000 successful requests — 0.005 per search, and only
successful ones are billed, so an error or an empty answer is free.

**`webSearchProvider` is now `auto | deepseek | free | duckduckgo | bing`.** `auto` uses
DeepSeek while it answers, and falls back to DuckDuckGo then Bing on `402`, `429`, `408`,
`5xx`, a network error or an empty result — saying so in the report rather than hiding
it. `deepseek` never substitutes: a failure is an error you can read. `free` never calls
DeepSeek at all.

**DuckDuckGo is asked once, not twice.** A `202` from the Lite endpoint is an anti-bot
throttle that applies to the whole address, so the HTML endpoint would answer the same;
it is only tried when Lite came back empty without being throttled. In the free chain
DuckDuckGo goes first, because it reads technical queries far better; Bing is the safety
net, since it never throttles. Bing RSS also reports `pubDate`, which the report now shows.

**Weak answers say they are weak.** The low-confidence notice is applied when DeepSeek
returns nothing scoring at least 1.5, when the free chain produces fewer than three
passing results, and always when Bing is the only source for a non-ASCII query — it
tokenises those badly and used to return dictionary entries for a Russian question.

**`web_fetch` falls back to DeepSeek Fetch.** Only when the local client cannot produce
text: a 403, a captcha wall, or a page that is empty once scripts are gone. The reply says
which source served the page.

**Tavily is gone.** Key, command, settings field, test button, `include_answer` and
`search_depth` parameters — all removed.

### ✂️ 2. Compaction cuts once, and deeply

**No pre-passes.** Repeated file reads used to be collapsed into placeholder tags and long
tool bodies shortened before any message was dropped. Both rewrite the middle of the
history, so the prefix cache dies from that byte onward, and both buy very little: a
measured run freed 50k tokens, rewrote 61 kept messages, and the history still crossed the
budget eight iterations later. The drop and the summary now run first; body shortening
survives only for a history too short to drop anything from.

**Requests stay inside the context window.** `maxOutputTokens` for both DeepSeek models
drops from 384 000 to 80 000. The provider validates `prompt + max_tokens` and rejects
rather than clamping, so the old value created an 85k dead zone where a request was
rejected while the compaction trigger had not fired yet. A `400` naming a context limit
is now retried once with the output cap trimmed.

**Two different cards instead of one wrong one.** A manual `/compact` that only shortened
tool output no longer claims that history was summarised.

### 🔗 3. One builder for the turn and for compaction

Both now build their message array through `buildRequestMessages`, so a compaction request
is literally the turn's request plus one instruction message. It was not before: the
rebuilt path assembled the array by hand and skipped the sanitiser's
`reasoning_content` backfill, so the two parted company at the first assistant message
that followed a thinking one. A 747k-token prompt collected a 165k cache hit for that
reason; the rebuilt path now matches the turn for the whole history, including after a
window reload where no snapshot survives.

Both sides log a hash again — `msgs_hash` on the turn, `prefix_hash` on the compaction
prefix — so "the two requests differ" and "the provider had no cached unit yet" can be
told apart by comparing two strings. `ITER_START` reports its message count after the
pre-flight cap and the orphan cleanup, so it no longer disagrees with the request that
follows it.

### ⚠️ Migrations

- **The first turn after upgrading pays one full cache miss.** Tool descriptions are part
  of the prompt, and the `web_search` description and its parameters changed. Nothing is
  broken; the cache simply has to be rebuilt once.
- **Search needs the DeepSeek key.** It is the same key the chat uses, so in practice
  nothing to do. Without it, `auto` silently lands on DuckDuckGo and Bing and reports
  `fallback_reason: "no_key"` in the log.
- **`webSearchProvider: "tavily"` becomes `auto`.** The key, if one was stored, stays in
  SecretStorage untouched — it is simply no longer read.
- **Output cap is lower.** Both DeepSeek models now allow 80 000 output tokens instead of
  384 000. In exchange the compaction budget rises from 664k to 750k usable tokens.
- **Log fields changed.** `[COMPACT]` no longer carries `deduped`; `bodies` counts messages
  rather than truncation operations. New: `[WEB_SEARCH]`, `[WEB_FETCH_FALLBACK]`.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v110.md`
- Full list: `git log 8e9dce0..HEAD --oneline`
