## Deep Copilot v0.31.0

### Install · 安装

Download **deep-copilot-0.31.0.vsix** from the Assets below, then:

```
code --install-extension deep-copilot-0.31.0.vsix --force
```

Or: VS Code Extensions panel → `⋯` → **Install from VSIX...**

---

## Highlights · 本次更新概览

**EN** v0.31.0 introduces `spawn_agent` — a parallel sub-agent dispatch system — along with GitHub Copilot-style streaming terminal cards, large-file safety, and a suite of reliability fixes targeting TLS connection reuse and network retry logic.

**中文** v0.31.0 带来 `spawn_agent` 并行子 Agent 调度系统，同时参照 GitHub Copilot 重做了终端工具卡片的交互（运行时流式展开 / 成功折叠 / 失败保留），修复了大文件安全读取及子 Agent TLS 连接复用等稳定性问题。

---

## What's New · 本版亮点

### 🤖 spawn_agent — Parallel Sub-Agent Dispatch · 并行子 Agent 调度

**EN** The new `spawn_agent` tool lets the main agent spawn isolated child agents that run concurrently. Each sub-agent gets a fresh, private context — only the final Markdown summary is returned to the parent. Designed for large research tasks that benefit from parallelism (e.g. "analyse three directories simultaneously").

Key design points:
- **Parallel execution**: multiple `spawn_agent` calls in one model turn run via `Promise.all` (no more serial queue).
- **Dedicated model**: sub-agents default to `deepseek-v4-flash` (new `deepseekAgent.subAgentModel` setting) so concurrent agents don't exhaust the Pro/R1 rate-limit quota.
- **TLS keep-alive**: each sub-agent reuses a single HTTPS keep-alive connection for all its iterations, eliminating repeated TLS handshakes.
- **Network retry**: transient errors (`ECONNRESET`, `ETIMEDOUT`, `socket hang up`, TLS reset…) are retried up to 3× with exponential back-off (800 ms → 1.6 s → 3.2 s).
- **Efficient file reading**: system prompt now instructs sub-agents to read ≥ 200 lines per call (full file if ≤ 400 lines), dramatically reducing round-trips on large files.
- **Max nesting depth = 1**: sub-agents cannot spawn further sub-agents.
- **Cascade abort**: cancelling the parent immediately aborts all live children.
- **explore mode** (default): read-only tools only; `general` mode exposes the full toolset.

**中文** 新增 `spawn_agent` 工具，让主 Agent 派生出并行执行的独立子 Agent。每个子 Agent 拥有隔离的上下文，只把最终 Markdown 摘要返回给父 Agent，适合需要并行分析多个目录 / 文件的大型研究任务。

核心设计要点：
- **并行执行**：同一轮模型输出的多个 `spawn_agent` 调用走 `Promise.all`，不再串行。
- **专属模型**：子 Agent 默认使用 `deepseek-v4-flash`（新增 `deepseekAgent.subAgentModel` 配置项），避免并发调用耗尽 Pro/R1 的速率配额。
- **TLS 连接复用**：每个子 Agent 全程复用同一个 keep-alive HTTPS 连接，只握手一次。
- **网络重试**：瞬态网络错误最多重试 3 次，退避时间 800ms → 1.6s → 3.2s。
- **大文件读取策略**：系统提示要求子 Agent 每次至少读 200 行（≤400 行一次读完），大幅减少 API 调用轮次。

---

### 🖥️ Streaming Terminal Cards · 流式终端卡片（对标 GitHub Copilot）

**EN** `run_shell` cards now behave exactly like GitHub Copilot terminal cards:

| Phase | Behaviour |
|---|---|
| **Running** | Card auto-expands; stdout/stderr stream in real-time with a blinking cursor `▍` |
| **Success** | Card auto-collapses; header shows summary `exit 0 · N lines · Ts` |
| **Failure** | Card stays expanded so the error is immediately visible; header shows `exit N · Ts` |
| **User toggled** | Once the user manually clicks the header, the card's state is locked — auto-collapse/expand no longer overrides it |

The same success-collapse / failure-expand rule applies to `web_search` cards.

**中文** `run_shell` 卡片现在完全对标 GitHub Copilot 终端卡片行为：

| 阶段 | 行为 |
|---|---|
| **运行中** | 卡片默认展开，stdout/stderr 实时流式追加，末尾闪烁光标 `▍` |
| **成功** | 自动折叠，header 摘要 `exit 0 · N 行 · Ts` |
| **失败** | 保持展开便于查错，header 摘要 `exit N · Ts` |
| **用户手动点击** | 锁定用户意图，后续自动状态不再覆盖 |

`web_search` 卡片同样适用成功折叠 / 失败展开规则。

**技术实现**：后端 `shell.js` 从 `spawnSync` 改为 `spawn`，每个 `data` 事件通过 `ctx.onStreamDelta` 回调 → `toolStreamDelta` 消息 → 前端 `<pre class="live-out">` 实时追加，完成后替换为 `<pre class="final-out">`。

---

### 📂 Large File Safety · 大文件安全读取

**EN** `read_file` on files > 10 MB now returns a structured `[large-file]` info block instead of loading the entire file into memory. The block includes file size, estimated line count, and pre-computed `spawn_agent` chunk parameters so the agent can safely read the file in parallel segments. Binary files (containing null bytes) are also detected early and return a `[large-binary-file]` advisory.

**中文** 读取超过 10 MB 的文件时，`read_file` 不再加载整个文件，而是返回结构化的 `[large-file]` 信息块，包含文件大小、估算行数和 8 段并行读取参数，引导 Agent 用 `spawn_agent` 安全分块读取。同时新增二进制文件检测（空字节检测）。

---

### 🔍 Prose Line Hover-Expand · Prose 行悬浮展开

**EN** Tool calls rendered as inline prose lines (e.g. `read_file`, `grep_search`) now reveal a `▶` expand arrow on hover. Click to expand the tool output inline; click again to collapse.

**中文** 以内联 Prose 行渲染的工具调用（如 `read_file`、`grep_search`）鼠标悬浮时会出现 `▶` 展开箭头，点击可展开查看完整工具输出，再次点击折叠。

---

## Bug Fixes · 问题修复

| # | Fix |
|---|-----|
| 1 | Sub-agent was discarding `reasoning_content` tokens → DeepSeek API returned HTTP 400 on next call in thinking mode |
| 2 | `spawn_agent` calls were executed serially (missing from `READ_ONLY` parallel set) → now run via `Promise.all` |
| 3 | Sub-agent TLS socket reset after many iterations → fixed with keep-alive HTTPS agent per sub-agent |
| 4 | Sub-agent network failures not retried → added 3× retry with exponential back-off |
| 5 | Shell/web-search cards were always auto-expanded → now collapse on success, expand on failure |
| 6 | Math formulas and table rendering conflict → inline math is now parked before `escHtml`/table-split |

---

## New Settings · 新增配置项

| Setting | Default | Description |
|---|---|---|
| `deepseekAgent.subAgentModel` | `deepseek-v4-flash` | Model used by `spawn_agent` sub-agents. Flash is recommended to avoid exhausting Pro/R1 rate limits when running multiple sub-agents in parallel. |

---

## Files Changed · 改动文件

| File | Change |
|------|--------|
| `src/tools/schema.js` | Added `spawn_agent` tool definition |
| `src/chat/sub-agent.js` | New: SubAgentRunner with keep-alive TLS, retry, file-read strategy |
| `src/chat/tool-executor.js` | Added `spawn_agent` dispatch; plumbed `tcId` for streaming |
| `src/chat/agent-loop.js` | Added `spawn_agent` to `READ_ONLY` parallel set; passed `tc.id` to `execute()` |
| `src/tools/shell.js` | `spawnSync` → `spawn` with streaming `onStreamDelta` callback |
| `src/tools/file-read.js` | Large-file / binary detection; streaming line-range reader |
| `src/api/deepseek.js` | Added `httpAgent` parameter for keep-alive connection reuse |
| `src/prompts/system.js` | Added `spawn_agent` guidance and large-file strategy |
| `media/chat.js` | `toolStreamDelta` handler; live tail + auto-collapse/expand; `spawn_agent` card |
| `media/chat.css` | `.live-out` / `.final-out` styles; sub-agent card accent color |
| `package.json` | Added `deepseekAgent.subAgentModel` setting; bumped version to 0.31.0 |
