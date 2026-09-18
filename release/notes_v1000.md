# Deep Copilot (difred) v1.0.0

**Topic: context and compaction, footer indicators, providers and pricing, tools and search, i18n, sessions and workspaces**

> First stable release of the **difred** fork — publisher `difr`, displayed as
> “Deep Copilot (difred)”, built on ZhouChaunge's Deep Copilot and packaged as
> `deep-copilot-1.0.0.vsix` (marketplace id `deep-copilot`). Everything below landed
> in the 43 commits since upstream v0.43.1, grouped into the six themes that shaped
> this version.

### 🧠 1. Context and compaction

**History stays cache-stable across compactions.** Compaction no longer rewrites the
head of the history on every pass: the policy is driven by settings, so repeated
compactions keep the prefix that DeepSeek's cache already holds.

**Message-count trigger compacts with a summary.** Reaching the message-count
threshold now produces the same summarized head as the token trigger, instead of
silently dropping messages.

**Summaries survive in the session panel.** A compaction summary is kept as a single
card at the top of the visible transcript, so the panel and the API history agree on
what the model still remembers.

**One prompt size everywhere.** The footer ring, the context popup and `/context`
report the same number, priced in provider units; `/compact` clears the recorded
prompt size, so the panel stops describing a history that no longer exists.

**Slash commands are history-aware.** `/compact` and `/context` read the history they
act on, and all three of `/context`, `/compact` and `/fork` are listed in the
slash-command catalogue with descriptions.

**Compaction is logged under one tag.** Both the automatic and the manual path log
`COMPACT` with a `trigger` field, so the log can be filtered by a single tag.

### 📊 2. Footer and indicators

**Footer rework.** Settings, the turn pill and the session tooltip were rebuilt as
one coherent bar.

**Context ring.** The `ctxUsage` ring shows prompt size at a glance and refreshes
when the panel opens or becomes visible again, alongside a popover with the detail.

**Pricing window ring.** The off-peak marker became a countdown: a background ring
coloured by the mode (green off-peak, red peak) with a grey ring on top that grows
with the time already spent, so the colour left is the time left in the window.

**Fast thinking.** A composer toggle (`deepseekAgent.fastThinking`) folds reasoning
sections and keeps their text out of the DOM while a turn runs, instead of appending
every delta to a `<pre>` and pinning the scroll. The composer row also reads model,
interaction mode, approvals in that order.

**Timestamps.** The action bar of the last answer carries a timestamp.

**Balance pill on a failed refresh.** A balance request that fails (network, timeout,
non-JSON reply) is now reported as an error rather than “unsupported”, so the pill keeps
the last known figure — dimmed, with the reason in its tooltip — and the failure is
logged as `BALANCE_FETCH_FAILED`. One flaky request no longer blanks the footer.

### 🔌 3. Providers and pricing

**Hourly pricing policy.** Vendors can declare `pricingPolicy.offPeakDiscount` with
peak windows and a timezone; declared prices are the peak ones and everything outside
the windows is discounted. DeepSeek ships with its windows preconfigured.

**Settings as provider overrides.** Provider settings, including the `deepseek-flash`
fast tier used by sub-agents, are resolved through `resolveModel` everywhere rather
than per call site.

**Inline completion fixes.** FIM settings, model fallback and `baseUrl` precedence
were corrected for the inline completion path.

### 🛠 4. Tools and search

**Web search backends.** DuckDuckGo became the no-key default with provider rotation,
and `deep_fetch` / `fetch_top` pull page content instead of snippets when needed.

**`grep_search` engine chain.** Ripgrep (PATH or the VS Code build) → `git grep` →
`findstr`, with an ignore-aware scope (`include_ignored`), a hint when hits are hidden
by `.gitignore`, a Windows-safe file mask path, and honest diagnostics counts.

**`file-read` scope.** `findFiles` is rooted correctly and diagnostics counts report
what was actually returned.

**`diff_files`.** New tool for comparing two files or two directories, with a compact
summary for directories.

**Editor tools.** `visibleTextEditors` fallback for the editor-context tools.

**Multi-encoding files and shell.** `deepseekAgent.fileEncoding` lets non-UTF-8 files
be read and written, and shell output decoded, without mangling.

**`str_replace_in_file` diagnostics.** Trailing-whitespace misses are diagnosed and
tolerated instead of failing opaquely.

**`memory_write`.** Section replacement is robust against repeated sections.

**System prompt.** Long-running tasks, plan language and `tmp/` handling were added to
the prompt guidance.

### 🌐 5. Internationalization and rendering

**English-only UI.** `i18n.js` was replaced by `src/utils/strings.js` with `t()` /
`tf()` and English strings; hardcoded Chinese strings are gone.

**Config descriptions in English**, including a Russian locale pass earlier in the
cycle.

**Dollar signs and backticks.** Inline code and chat text no longer feed `$…$` into
the math renderer, so prices and shell snippets display verbatim.

### 🗂 6. Sessions and workspaces

**Workspace-scoped sessions.** Opening the panel binds to the session of the current
workspace (remembering the last opened one) and replays it into the fresh webview,
instead of resuming whichever session was newest globally.

**Workspace labels.** Cross-workspace sessions show their workspace name in the
history panel, and the badge is visible for sessions of the current workspace.

**Session fork.** A fork binds to the current workspace.

**Session titles** follow the language of the conversation.

**Migration tooling.** `migrate-sessions` accepts `--from` / `--to` / `--db`, detects
the database automatically, and speaks English; the fork rebrand ships with it.

**Log housekeeping.** Old log directories are cleaned wherever they live, not only in
the current one.

### ⚠️ Migrations

- **This is the `difred` fork** (publisher `difr`, display name “Deep Copilot (difred)”,
  marketplace id `deep-copilot`, upstream author ZhouChaunge). Installing it alongside or
  instead of the previous build keeps your settings, since keys stay `deepseekAgent.*`.
- **Existing sessions are migrated** with the bundled script (`migrate-sessions`), which
  finds the source database on its own and can be pointed at a specific one.
- **The UI is English-only.** The previous Chinese strings and the Russian locale are
  gone; text flows through `strings.js`.
- **Non-UTF-8 projects** should set `deepseekAgent.fileEncoding` for the affected paths,
  otherwise files read as mojibake.
- **Compaction policy is settings-driven.** If you customized the old defaults, review
  `deepseekAgent.compactPolicy` and the related budget share before upgrading.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v0431.md`
- Full list: `git log 9ecbb66..HEAD --oneline`
