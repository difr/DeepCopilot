# Deep Copilot v0.41.6

> 中文版在下方 / English notes below.

## 🇨🇳 中文

主题：**Archive 改为纯导出 · 值守任务不再提前结束会话 · 打包卫生**

### 🐞 修复 1：Archive 语义改为「纯导出」（Issue #169）

旧版「存档」实际上是「软隐藏 + 导出」——点一下生成 Markdown，同时把会话从侧边栏抽走，连点两次第二次还会把它「unarchive」回来，体验和菜单文案完全不符。

**新行为（PR #170）**：

- `archive(id)` 只做一件事：调用 `exportSessionToMarkdown` 把整个会话渲染为 Markdown，写到 `.deep-copilot/archives/yyyyMMdd-HHmmss-<title>.md`。
- **不再** 把 `archived` 置为 `true`，**不再** 把当前激活的 session 切走，**不再** 广播 `sessionLoaded` 空消息。
- 出错或用户在保存对话框里取消，session 状态都保持原样——只 toast 一下。
- 同一会话连点两次「存档」 → 生成两个 md 文件，会话本体不动。

**一次性迁移** `_migrateArchivedFlagIfNeeded`：

- 由 `globalState['deepseekAgent.archiveSemanticsV2Migrated']` 守护，幂等；
- 升级到本版本后**首次启动**会把所有旧 `archived: true` 的会话翻回 `false`，让侧边栏重新看到它们；
- 失败走 `Logger.info('ARCHIVE_V2_MIGRATION_FAILED', { message, stack })`，下次启动自动重试，不阻塞激活；
- 仅当真有 session 被翻转时才调 `postList()`，避免无谓刷新。

> ⚠️ 兼容性：升级后曾经被「藏起来」的所有会话会一次性回到侧边栏。`.filter(s => !s.archived)` / `find(s => !s.archived)` 这两处过滤器保留，作为 schema 向后兼容；后续 minor 版本会移除 `archived` 字段。

### 🐞 修复 2：值守任务不再被提前掐断

模型执行「值守」类任务（盯训练、盯长跑构建、盯日志）时，如果那个 bg job 是在**上一个 turn** 启动的，当前 turn 的 `run._sessionStartedBgJobs` 是空集，`BG_WAIT_SKIPPED_MODEL_DONE` 守卫就会在模型说完「我会持续监控」之后**立刻**结束 turn，把值守静默掐断——用户看着模型像断片一样不再有任何后续。

**修复**：

- `src/chat/tool-executor.js` 新增对 `read_terminal(terminal: "deepseek-job-*")` 的拦截：当模型读取某个后台任务的终端输出时，把该 jobId 记入 `run._monitoredBgJobs`，作为「当前 run 正在主动监控该任务」的信号。
- `src/chat/agent-loop.js`：
  - 初始化 `run._monitoredBgJobs = new Set()`；
  - bg job 结束事件同步清理该集合；
  - `BG_WAIT_SKIPPED_MODEL_DONE` 守卫新增 `_hasMonitoredRunningJob` 条件——任何被监控且仍活着的 bg job 都会阻止 turn 提前退出，循环继续走 4 分钟快照 / 等结束事件，直到任务完成或命中 4h 本轮预算。

### 🛠 修复 3：迁移失败走 `Logger`（替换 `console.warn`）

`_migrateArchivedFlagIfNeeded` 的失败分支改用 `Logger.info('ARCHIVE_V2_MIGRATION_FAILED', { message, stack })`，统一走 Deep Copilot Debug 输出面板，符合仓库已有的 `src/logger.js` 路径。

### 🧹 打包卫生

`.vscodeignore` 增加 `.tmp-*.json` / `.tmp-*.txt` / `.tmp-*.md` 过滤规则，防止本地拉取 PR 评论 / Review API 时产生的临时缓存文件被打进 VSIX。

### 🔒 安全 / 兼容性

- Webview CSP 不变。
- 不引入新运行时依赖。
- Archive 旧 md 文件（`.deep-copilot/archives/*.md`）原封不动。
- Watchdog 改动只放宽提前退出条件，不改变正常 turn 结束语义；模型从未 `read_terminal` 过的 bg job（例如旁路 dev server）依然走老的 short-circuit。

### 关联

- Issue #169（archive 语义）
- PR #170（本版本合并 PR）
- 衍生自 #165 / PR #166 的 archive 讨论

---

## 🇺🇸 English

Theme: **Archive becomes a pure export · watchdog turns stay on duty · packaging hygiene**

### 🐞 Fix 1 — Archive semantics: pure export (Issue #169)

Pre-#169 the "Archive" action was actually "soft-hide + export": it produced a Markdown snapshot but *also* swept the session out of the sidebar; clicking the same row a second time silently un-hid it. The menu label promised one thing, the behaviour did another.

**New behaviour (PR #170)**:

- `archive(id)` does exactly one thing: call `exportSessionToMarkdown` to render the whole session to `.deep-copilot/archives/yyyyMMdd-HHmmss-<title>.md`.
- It no longer sets `archived = true`, no longer swaps `sessionId` to null, no longer broadcasts a `sessionLoaded` empty message.
- On error or user-cancelled save dialog, session state is untouched — only a toast.
- Clicking "Archive" twice on the same session produces two snapshots; the session itself stays put.

**One-shot migration** `_migrateArchivedFlagIfNeeded`:

- Idempotent, guarded by `globalState['deepseekAgent.archiveSemanticsV2Migrated']`.
- On first launch after upgrade, flips every legacy `archived: true` back to `false` so old hidden sessions reappear in the sidebar.
- Failure routes through `Logger.info('ARCHIVE_V2_MIGRATION_FAILED', { message, stack })`; the next launch retries because the flag was never written. Activation is never blocked.
- `postList()` only fires when something actually changed.

> ⚠️ Compatibility: every session that used to be hidden by the old archive flow will reappear in the sidebar exactly once after this upgrade. The `.filter(s => !s.archived)` and `find(s => !s.archived)` call-sites are kept as a no-op safety net so the data schema stays backward-compatible; a future minor release will drop the field.

### 🐞 Fix 2 — Watchdog turns no longer cut themselves off

When the model is asked to watch a long-running background job (training, build, dev server), and that job was spawned in an *earlier* turn, the current turn's `run._sessionStartedBgJobs` is empty. The `BG_WAIT_SKIPPED_MODEL_DONE` guard would then end the turn the instant the model said "I'll keep monitoring", silently dropping the watchdog. Users would see the model go quiet right after promising to stay on duty.

**Fix**:

- `src/chat/tool-executor.js` now hooks `read_terminal(terminal: "deepseek-job-*")`: inspecting a `deepseek-job-*` terminal in this run adds that jobId to `run._monitoredBgJobs` — a signal that the model is actively watching the job.
- `src/chat/agent-loop.js`:
  - Initialises `run._monitoredBgJobs = new Set()`.
  - Clears entries when the corresponding bg-job-end event fires.
  - Adds `_hasMonitoredRunningJob` to the early-exit guard; as long as any monitored job is still alive, the turn refuses to end and keeps polling / emitting 4-minute snapshots until the job finishes or the 4-hour per-turn budget elapses.

### 🛠 Fix 3 — Migration failures use `Logger` (not `console.warn`)

`_migrateArchivedFlagIfNeeded` now routes its failure path through `Logger.info('ARCHIVE_V2_MIGRATION_FAILED', { message, stack })`, matching the repo's existing `src/logger.js` pipeline so diagnostics respect `deepseekAgent.enableDebugLog` and land in the "Deep Copilot Debug" output channel.

### 🧹 Packaging hygiene

`.vscodeignore` now filters `.tmp-*.json` / `.tmp-*.txt` / `.tmp-*.md`, so scratch files created locally while pulling PR comments or review payloads via the GitHub API never end up shipped inside the VSIX.

### 🔒 Security / compatibility

- Webview CSP unchanged.
- No new runtime dependencies.
- Existing archive Markdown files (`.deep-copilot/archives/*.md`) are untouched.
- The watchdog change only loosens the early-exit guard; it does not change normal turn-end semantics. Bg jobs the model never inspected via `read_terminal` (e.g. a side-channel dev server) still go through the original short-circuit.

### Related

- Issue #169 (archive semantics)
- PR #170 (this release was merged via PR #170)
- Continuation of the archive discussion from #165 / PR #166
