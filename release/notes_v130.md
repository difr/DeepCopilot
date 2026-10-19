# Deep Copilot (difred) v1.3.0

**Topic: a panel for the questions the model asks, and a tool pane that shows the output**

> Fourth release of the **difred** fork. The assistant can now end a reply with a panel of
> questions and options, answered in one click instead of typed by hand. The tool card grew
> a detail pane that finally shows what the command printed instead of the JSON envelope it
> arrived in, and copying a reply keeps its markdown.

### 🗣 1. The model can ask, and you answer in a panel

**A reply may end with a panel of up to five questions.** Each is `single`, `multi` or
`text`, with options and an optional “type your own” field. Answers land in the composer as
quoted question and plain answer lines, already positioned above whatever you had typed, so
you can edit them before sending — the panel never sends anything by itself.

**The block is intercepted on the stream, never rendered.** `AskGate` watches the output of
the model, and a well-formed `<ask>[…]</ask>` becomes a card in the webview. The same block
stays in the stored history untouched, so the prompt prefix of the next request still
matches and the cache survives. Questions are numbered by position, so a duplicate or a
missing id from the model cannot merge two questions into one answer.

**Malformed blocks degrade instead of breaking the reply.** If the JSON does not parse, or
the closing tag never arrives, the raw text is shown inside a fenced block — visible, not
swallowed.

### 🧰 2. The tool pane shows the output, not the envelope

**`toolResult` used to reach the webview as `result.slice(0, 600)`.** That slice cut the
JSON envelope, so the pane failed to parse it and printed a fragment: asking `git diff` in
the shell produced `{"command":…,"stdout":"diff --git a/media/c. The cap now applies to the
payload — `stdout` and `text` at 8 KB, `stderr` at 2 KB, arrays capped at 40 items — while
the envelope stays valid, so the pane renders the diff. The model still receives the whole
output: this cap is for display only.

**Long lines wrap.** `pre` inside the pane had no wrapping rule, so a one-line JSON or a
long path turned the whole pane into a horizontal scrollbar.

**The header row sizes to its content.** Every label was stretched with `flex: 1`, pushing
the target to the panel edge and dragging the status and the chevron along with it. Rows
now size to their content and align on the centre line, with 8 px after the status dot.

### 📋 3. Copy keeps markdown

**Copying a reply produced rendered text.** The last segment's `data-raw` was written after
the aggregation loop had already read it, so the loop fell back to `textContent` — markdown
gone, code-block button labels mixed in. It is written first now.

**Segments are joined with a blank line.** One newline glued a heading or a list to the
paragraph above it, and empty service fragments left runs of blank lines.

### ⏱ 4. Background jobs: the description caught up with the code

**A background job keeps the turn alive by itself.** While it runs the turn cannot be
closed, and when it ends you are re-invoked in the same turn with its exit code and output;
no `watch` is needed for that. For a job that outlives a conversational step, `watch` plus
`yield_turn` hands the turn back, and the session resumes on its own.

**`yield_turn` fails when the watcher already fired.** A job that ends in seconds beats the
yield; that is not an error, the digest simply arrives in the current turn. Both the prompt
and the tool hints said otherwise — the hint claimed the turn could not be closed at all,
which contradicted the long-task path.

**`npm run build` no longer auto-redirects to the background.** The list is for commands
that never finish, not for ones that are merely long: this repository's build takes 135 ms,
and backgrounding it only created a race with the yield. Dev servers, watchers, training,
`cargo build` and `docker build` still redirect.

**Logs name the decision.** `[SHELL_MODE]` carries `force_foreground`, `in_terminal` and
`timeout_ms`; `[SHELL_AUTO_BG_REDIRECT]` carries the patterns that matched and the `jobId`
it produced.

### ⚠️ Migrations

- **The first turn after upgrading pays one full cache miss.** The system prompt changed in
  three places (the ask panel, file write safety, long-running tasks), and the system
  prompt is part of the cached prefix. Nothing is broken; the cache is rebuilt once.
- **`npm run build` now runs in the foreground.** A build that genuinely takes minutes will
  hit the 30 s timeout and return a hint instead of silently moving to the background.
- **Tool output in the pane is capped.** 8 KB for `stdout` and `text`, 2 KB for `stderr`,
  40 items per array, each with a `…[truncated]` marker. The model is unaffected.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v120.md`
- Full list: `git log fcf697f..HEAD --oneline`
