# Deep Copilot (difred) v1.1.0

**Topic: cache-stable compaction, per-model reasoning effort, chat find widget**

> Second release of the **difred** fork. Everything below landed in the 4 commits
> since v1.0.0, and most of it is about one thing: keeping DeepSeek's prompt cache
> warm. A compaction that replays the turn's exact request, and a reasoning depth
> declared on the model instead of decided per turn, both exist because a request
> whose shape changes is a request that pays full prefill again.

### 🧠 1. Compaction rides the prefix cache

**The compaction request is now the turn's own request.** Compaction used to send a
freshly built prompt, so nothing it sent matched what the provider had cached: on a
280-message history the hit was 13.96%, and one measured run dropped to 3.8% with the
prompt half its real size. It now replays the exact message array the last turn sent —
captured after sanitisation, returned by the adapter as `sentMessages` — so the cache
carries over. Measured after the change: 99.8% on a 297k-token prompt.

**The checkpoint is a fixed structure.** The summariser is asked for eight named
sections and told to emit `(none)` rather than drop one, which makes a checkpoint
resumable and a stub obvious. Earlier checkpoints could come back as a 160-character
answer with zero sections and be accepted as the summary.

**Previous checkpoints are merged, not stacked.** Each prior checkpoint used to be
prepended whole, so the third compaction carried three copies of every section. Epochs
are now flattened and merged into one set of headings, oldest body first, and the same
helper is used by the emergency path.

**Truncation no longer touches answers.** As a last resort the head is trimmed by tiers;
assistant messages and the checkpoint itself are skipped now, and a body that already
carries a truncation marker is never trimmed twice. Previously long assistant replies
came back cut in half in the visible history.

**Manual `/compact` keeps a proportional tail.** The verbatim tail is now a fraction of
the history rather than the full 200-message policy value, which used to cover the whole
history and make the command report "already compact".

### 🎯 2. Reasoning effort is a property of the model

**`reasoningEffort` is declared per model** in `src/providers/*.json` (`low`, `high`,
`max`) and both DeepSeek models ship on `max`. The value is part of the request, so a
depth that changed between turns used to cost the whole prefix: entering a new level
measured 0% cache hit — 206k tokens of prefill on a 282-message history — while staying
on one level held 99.5–99.9%. The caller's explicit value still wins over the model's,
which is how sub-agents keep their own levels: `explore` runs on `low`, `general` on
`high`.

**Why not a per-turn toggle.** A composer button for max effort was built, measured and
removed. Besides the cache cost on every switch, nothing showed the deeper level solving
tasks better; the reasoning-token spread within one level was wider than the difference
between levels.

### 🔎 3. Smaller things

**Find in the chat tab.** The transcript has an in-panel find widget instead of relying
on the editor's.

**VSIX artifact name.** The packaged file now carries the fork prefix
(`deep-copilot-difred-<version>.vsix`), so it cannot be confused with upstream builds.

### ⚠️ Migrations

- **Both DeepSeek models now reason at `max` effort.** This raises output tokens, and the
  first request after the upgrade pays one full cache miss because the request shape
  changed. No setting is involved: the value is in the provider config, so reverting means
  editing `reasoningEffort` in `src/providers/deepseek.json` or unpacking the extension.
- **Existing compacted sessions are not repaired.** Histories whose assistant replies were
  truncated by older builds stay truncated; the bodies go away on the next compaction.
- **Nothing else changes shape.** Settings keys, session storage and the session panel are
  untouched, so an in-place upgrade keeps everything.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v1000.md`
- Full list: `git log c1f4a82..HEAD --oneline`
