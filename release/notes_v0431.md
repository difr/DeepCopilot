# Deep Copilot v0.43.1

> 中文版在下方 / English notes below.

## 🇨🇳 中文

主题：**工具调用前穿插逐步文字解说 + 后台唤醒调度 + DeepSeek 前缀缓存调优**

> 本版本主要打包 PR #180（v0.43.0）的全部能力，并以 0.43.1 重新构建 VSIX。

### ✨ 新特性 1：每个工具调用前都有「人话解说」

此前多步工具回合常常表现为「一堆工具先跑，最后才蹦出文字」。日志里每个 `ITER_END` 的 `assistant_chars:0` 说明模型把「我现在要做 X」的解说全塞进了 DeepSeek 的隐藏 `reasoning_content` 通道，可见正文 `content` 全程为空。

**修复（`src/prompts/system.js`）**：

- **Tone 段**：把原来禁止前导解说的 `No preamble, no "I'll now…"` 改成「禁空话（Great question/Sure），但要求动作解说」——每次工具调用前用一句可见正文说明「要做什么 + 为什么」。
- **System 段**：新增强约束，要求把面向用户的解说写进 `content` 而非 reasoning/thinking 通道；多步工具回合里每个工具调用前先写一句，而不是沉默到最后。
- 流式管道（`src/api/openai-client.js`）本身已支持 `content` 先于 `tool_calls` 穿插渲染，无需改动。

体验上更接近 GitHub Copilot「先说一句话 → 再调工具」的节奏，用户能跟着模型一步一步看。

### ✨ 新特性 2：`watch` + `yield_turn` 后台唤醒调度

长跑任务（模型训练、大型构建、长下载、dev server）的痛点是：要么阻塞 turn 等到超时，要么手动轮询。

**新增工具**：

- `watch({ condition, description? })`：注册一个声明式触发器，支持 `time_elapsed` / `job_end` / `output_match` / `output_silent` / `progress_at`，可用 `first_of` 组合（成功 OR 失败 OR 卡死 OR 兜底超时）。
- `yield_turn({ reason? })`：干净地结束当前 turn，会话进入挂起状态。
- 任一 watcher 触发 → 由 `wake-scheduler` 构建结构化 digest（异常 / 进度 / 输出尾巴）→ 通过 `Provider.autoResume` 自动恢复对话。

**安全约束**：

- `watch` 的条件**必须**包含 `time_elapsed` 兜底（直接或在 `first_of` 中），否则被工具拒绝——避免会话永久挂起。
- `yield_turn` 必须在 `watch` 之后调用；空 watcher 列表会被拒绝。
- 每会话最多 8 个 active watcher，每小时最多 12 次 auto-resume（可通过 `deepseekAgent.autoResumeMaxPerHour` 配置）。
- 挂起前必须有一句用户可见的总结（「我做了 X / 现在在等 Y」），否则系统会主动 nudge 一次。

**新增模块**：

- `src/chat/wake-scheduler.js`（407 行）：watcher 生命周期、轮询、限流、路由
- `src/chat/digest.js`（144 行）：本地、确定性、无网络的输出 digest 构造器，自动抽取 anomaly / progress
- `src/tools/sleep.js`（139 行）：`watch` / `yield_turn` 的模型侧入口

### ⚡ 优化：DeepSeek 前缀缓存命中率

DeepSeek 服务端 KV 前缀缓存按字节比对。任何在历史中段重写消息的操作都会让从该字节起的整条 prefix cache miss，明显推高 token 成本。本版本系统性地审计并修复了若干「无意中破坏前缀」的代码路径：

- **系统提示重排**（`src/prompts/system.js`）：按 stability 由低到高排序（env → paradigm → skills → memory → workspace），让最长可能的前缀在跨 turn 时保持字节一致；移除原本的 `__DYNAMIC_BOUNDARY__` 噪音 marker。
- **持久化时不再 eager 压缩**（`src/chat/session-store.js`）：之前每次 turn save 都强制压缩到 40% context window，反复改写历史头部 → 每次「重开同一会话」都吃满 prefix cache miss。改为完全 lazy，只在 agent loop 里真正撑爆时压缩。
- **去掉定期重压缩**（`src/chat/agent-loop.js`）：原本每 12 iter 把 budget 收紧到 80% 触发预防性压缩——节奏性地清空 prefix cache。改为只在真正超出（更宽松的 70%）才触发。
- **dedup 阈值提到 95%**（`src/chat/compact.js`）：重复文件读取去重会改写中段消息，cost cache。改成「快要溢出才做」。
- **附件排序稳定化**（`src/chat/agent-loop.js`）：同一组文件按不同顺序点选 → byte-identical 的 user content，命中前缀缓存。
- **截断结果冻结**（`src/chat/compact.js`）：已被截断的工具结果加 `_cacheFrozen` 标记，避免反复重算导致对象身份变化。
- **可观测性**：每轮 USAGE 事件新增 `cache_hit_rate` 字段；日志同步打出 `CACHE_HIT_RATE` 行。

### 🐞 修复 1：空响应自愈

模型偶发输出 0 token + 0 工具调用（mimic reasoning placeholder 后停止），旧代码当作「正常结束」直接退出 turn，表现为「鬼魂中断」。新增最多 2 次的 `EMPTY_REPLY_RETRY`：注入 forward nudge 让模型继续，超过上限才放弃，避免无限循环。

### 🐞 修复 2：reasoning_content 占位符不再诱导模型「跟着说停」

DeepSeek thinking 模式要求一旦出现过 `reasoning_content`，后续每条 assistant 消息都必须带非空 reasoning，否则 HTTP 400。我们之前用的占位符 `"(no thoughts surfaced for this step)"` 重复出现后变成强 in-context 模板，模型开始照着发然后停下——又一种「鬼魂中断」。

通过 `scripts/probe-reasoning-placeholder.js` 实测验证：thinking 模式只要求**非空**字符串。改成 forward-nudging 的 `"Continue with the next concrete step."`——即便被模型 mimic，也是「继续干活」而不是「停下来」。

### 🐞 修复 3：Windows cmd.exe 多行 inline 脚本陷阱提示

`python -c "..."` / `node -e "..."` 这类多行内联脚本在 Windows 上会被 cmd.exe 按换行切碎，常表现为「exit 0 + 无输出」。`src/tools/shell.js` 现在会检测这种 pattern，在结果里追加 actionable hint：建议写到临时文件再执行，或改用单行命令。

### 🐞 修复 4：Provider sanitize 防止 `_` 前缀字段泄露到 HTTP

`_cacheFrozen` 这类 compactor / agent-loop 用的内部标志一旦混进 OpenAI 兼容 API 的 payload，会被 HTTP 400 拒绝。`src/providers/index.js` 的 `sanitizeMessages` 现在统一剥离所有 `_` 前缀字段，并用 spread（非 `Object.assign`）规避 `__proto__` 原型污染风险。

### 🐞 修复 5：terminal capture 饱和不再被误判为「沉默」

`run_shell_bg` 的输出捕获有 64KB×20 上限。原来当 capture 触顶停止增长时，`output_silent` watcher 会误以为任务沉默而提前触发。现在 `terminal-monitor.js` 在 record 上设置 `truncated` 标记，watcher 看到饱和后保持「仍活跃」语义。

### 🐞 修复 6：rate limit 不再永久销毁 watcher

`_fire` 命中限流时旧代码会先 `_cleanupWatcher` 再检查 rate——直接把 watcher 拆了，挂起的会话再也唤不醒。改为先检查、限流命中时保留 watcher 并 arm 单个 retry timer 到限流窗口释放为止。

### 🧹 其他

- 侧边栏抽屉打开时主区域 push（不再 cover），右侧空出 280px，体验更接近原生侧栏（`media/chat.css` + `media/chat.js`）。
- 新增配置项 `deepseekAgent.autoResumeMaxPerHour`（默认 12，范围 1–120）。
- 默认 `compactBudgetTokens` 从 50% context window 提到 70%，配合前缀缓存调优。

### 🔒 安全 / 兼容性

- Webview CSP 不变。
- 不引入新运行时依赖。
- 旧会话兼容，无需迁移。
- 新工具 `watch` / `yield_turn` 不暴露 destructive 能力，被 schema 验证 + 安全兜底约束。

### 关联

- PR #180（本版本合并 PR）

---

## 🇺🇸 English

Theme: **Per-step narration before each tool call · auto-resume scheduler · DeepSeek prefix-cache tuning**

> This release packages everything from PR #180 (v0.43.0) and rebuilds the VSIX as 0.43.1.

### ✨ Feature 1 — Plain-text narration before every tool call

Previously, multi-step tool turns showed up as "a bunch of tools fire silently, then text appears at the very end". Logs consistently reported `ITER_END` with `assistant_chars:0` — the model was stuffing its "I'm about to do X because Y" narration into DeepSeek's hidden `reasoning_content` channel, leaving the visible `content` channel empty.

**Fix (`src/prompts/system.js`)**:

- **Tone section**: replaced the old anti-preamble line (`No preamble, no "I'll now…"`) with "no empty filler (Great question/Sure), but DO narrate actions" — one short visible sentence before each tool call saying what and why.
- **System section**: hard rule that user-facing narration must land in `content`, not in `reasoning_content`/`thinking`; in multi-step turns, narrate before every tool call rather than at the end.
- The streaming pipeline (`src/api/openai-client.js`) already supports interleaving `content` before `tool_calls`, so no plumbing change was needed.

The result reads like GitHub Copilot's "say one sentence → call tool" cadence; users can follow the agent step by step.

### ✨ Feature 2 — `watch` + `yield_turn` auto-resume scheduler

Long-running shell work (training, large builds, downloads, dev servers) used to either block the turn until timeout or require manual polling. This release introduces declarative auto-resume:

**New tools**:

- `watch({ condition, description? })` — register a declarative trigger. Supported kinds: `time_elapsed` / `job_end` / `output_match` / `output_silent` / `progress_at`. Compose with `first_of` (success OR failure OR hang OR fallback timeout).
- `yield_turn({ reason? })` — cleanly end the current turn; the session enters a suspended state.
- When any watcher fires, `wake-scheduler` builds a structured digest (anomalies / progress snapshot / output tail) and `Provider.autoResume` re-enters the agent loop with it injected as a `<system-reminder channel="auto-wake">`.

**Safety constraints**:

- `watch` conditions **must** include a `time_elapsed` safety bound (directly or inside `first_of`) — otherwise the tool rejects the call. A session can never be suspended forever.
- `yield_turn` requires at least one armed watcher, otherwise it is rejected.
- Per-session caps: 8 active watchers; 12 auto-resumes per hour (configurable via `deepseekAgent.autoResumeMaxPerHour`).
- The model is required to write a brief user-facing summary ("did X / now waiting for Y") before suspending — a nudge is injected once if it tries to suspend silently.

**New modules**:

- `src/chat/wake-scheduler.js` (407 lines) — watcher lifecycle, polling, rate-limiting, routing.
- `src/chat/digest.js` (144 lines) — local, deterministic, network-free digest builder; extracts anomaly lines and progress snapshots.
- `src/tools/sleep.js` (139 lines) — `watch` / `yield_turn` entry points exposed to the model.

### ⚡ Optimisation — DeepSeek prefix-cache hit-rate

DeepSeek's server-side KV prefix cache hashes the request byte-by-byte. Any rewrite of mid-history bytes invalidates the cache from that point onward — silently driving up token cost. This release systematically audits and fixes paths that were unintentionally breaking the prefix:

- **System prompt re-ordering** (`src/prompts/system.js`): sections re-ordered most-stable-first (env → paradigm → skills → memory → workspace). The literal `__DYNAMIC_BOUNDARY__` marker is removed (cache-irrelevant noise).
- **No more eager compaction on persist** (`src/chat/session-store.js`): the old "compact to 40% of context window on every save" pass rewrote the head of history on every turn-save and every reload, so "reopen the same session" always paid a full prefix-cache miss. Compaction is now fully lazy.
- **No more periodic re-compaction** (`src/chat/agent-loop.js`): the old "every 12 iterations, tighten budget to 80%" trigger was a periodic cache-buster. Compaction now fires only when the real token estimate actually exceeds the (already-generous) 70% budget.
- **Dedup raised to 95%** (`src/chat/compact.js`): deduplicating repeated file reads rewrites mid-history messages and costs the cache. Defer to a near-overflow trigger.
- **Stable attachment ordering** (`src/chat/agent-loop.js`): sorting text attachments by (path, line-range) means the same files added in different click orders yield byte-identical user content — and therefore the same prefix-cache hit.
- **Frozen truncated tool results** (`src/chat/compact.js`): once a tool result has been truncated, it's marked `_cacheFrozen` so the truncator never runs over it again (guaranteed object identity → byte identity).
- **Observability**: every USAGE event now carries a `cache_hit_rate` field; `CACHE_HIT_RATE` log lines surface the hit/miss split per turn.

### 🐞 Fix 1 — Empty-response self-heal

The model occasionally emits a degenerate turn: no text AND no tool call (it just mimics the reasoning placeholder and stops). The old code treated that as a normal end-of-turn and silently broke out — a "ghost interruption". A capped `EMPTY_REPLY_RETRY` (max 2) now injects a forward-nudge and continues; only after that gives up.

### 🐞 Fix 2 — `reasoning_content` placeholder no longer trains the model to stop

DeepSeek thinking-mode enforces that once any assistant message carries a non-empty `reasoning_content`, every subsequent assistant message must too (else HTTP 400). The previous placeholder `"(no thoughts surfaced for this step)"` repeated across many turns became a strong in-context template — the model started mimicking it and then stopping (another flavour of ghost interruption).

A live probe (`scripts/probe-reasoning-placeholder.js`) verified that the 400 gate only requires *any* non-empty string. The placeholder is now `"Continue with the next concrete step."` — when mimicked, the in-context pattern says "keep going" instead of "I'm done".

### 🐞 Fix 3 — Windows cmd.exe multi-line inline-script hint

On Windows, `run_shell` spawns via `shell: true` → cmd.exe, which treats a literal newline as a command separator. A multi-line `python -c "..."` / `node -e "..."` gets split apart mid-quote and typically runs as a no-op (exit 0, empty stdout) — which then confuses the model ("did my script run?"). `src/tools/shell.js` now detects this exact pattern and appends an actionable hint: write the code to a temp file first, or use a single-line command.

### 🐞 Fix 4 — Provider sanitize strips `_`-prefixed fields

Internal flags like `_cacheFrozen` used by the compactor / agent-loop must never reach the OpenAI-compatible API payload (it rejects unknown fields with HTTP 400). `sanitizeMessages` in `src/providers/index.js` now strips every `_`-prefixed field, and uses object spread (not `Object.assign`) to avoid `__proto__` prototype-pollution footguns.

### 🐞 Fix 5 — Saturated terminal capture is no longer mistaken for "silence"

`run_shell_bg`'s output capture is capped at 64KB × 20. When the cap is hit, the captured length stops growing even though the job is still chatty. The `output_silent` watcher would then fire spuriously. `terminal-monitor.js` now sets a `truncated` flag on the record; the watcher treats saturated captures as "still active" instead of silent.

### 🐞 Fix 6 — Rate-limited watchers no longer get permanently destroyed

When `_fire` hit the rate limit, the old code tore down the watcher *before* checking the limit — leaving the suspended session with no way to ever resume. The watcher is now kept armed; a single retry timer is scheduled for when a slot frees up.

### 🧹 Misc

- The session drawer now uses push-layout (main shrinks by 280px) instead of overlay/cover — feels more like a native sidebar (`media/chat.css` + `media/chat.js`).
- New config `deepseekAgent.autoResumeMaxPerHour` (default 12, range 1–120).
- Default `compactBudgetTokens` raised from 50% → 70% of context window, complementing the prefix-cache tuning.

### 🔒 Security / Compatibility

- Webview CSP unchanged.
- No new runtime dependencies.
- Existing sessions remain compatible; no migration required.
- New `watch` / `yield_turn` tools expose no destructive capability and are constrained by schema validation + safety bounds.

### Related

- PR #180 (the merge PR for this release)
