## Deep Copilot v0.30.0

### Install · 安装

Download **deep-copilot-0.30.0.vsix** from the Assets below, then:

```
code --install-extension deep-copilot-0.30.0.vsix --force
```

Or: VS Code Extensions panel → `⋯` → **Install from VSIX...**

---

## Highlights · 本次更新概览

**EN** v0.30.0 is a consolidation release that rolls up every fix and refinement landed during the `0.28.x` series and ships the codebase as a stable, fully-modular baseline. No backend, no telemetry, no extra installs — just drop the VSIX in and go.

**中文** v0.30.0 是一次整合版本，把 `0.28.x` 系列累积的修复与打磨一次性收敛为稳定基线。仍然是零后端、零遥测、零额外依赖，VSIX 装上即用。

---

## What's New · 本版亮点

### 🧱 Modular Source Layout · 模块化重构

**EN** The runtime has been split into focused modules so contributors (and the agent itself) can navigate the codebase quickly:

```
src/
├─ extension.js          # activation / command wiring
├─ api/deepseek.js       # provider client
├─ chat/                 # agent loop, provider, tool executor, compact, session store
├─ tools/                # file-read / file-write / exec / shell / web-search
├─ prompts/system.js     # system prompt
├─ hooks.js · mcp.js     # post-tool hooks + MCP client
└─ webview/html.js       # chat UI shell
```

**中文** 运行时拆分为高内聚的模块（`chat/`、`tools/`、`api/`、`webview/` 等），方便二次开发和 Agent 自己阅读代码。

---

### 🔌 MCP Client (stabilized) · MCP 客户端（稳定化）

**EN** Connect any MCP-compatible stdio server; tools are exposed as `mcp__<server>__<tool>` next to built-ins. Configure via VS Code settings:

```json
"deepseekAgent.mcp.servers": [
  { "name": "my-db", "command": "npx", "args": ["my-db-mcp-server"] }
]
```

**中文** 连接任意 MCP stdio 工具服务器，工具以 `mcp__<server>__<tool>` 形式与内置工具并列。

---

### 🪝 Post-Tool Hooks · 工具后置钩子

**EN** Run scripts after any tool call; their output is fed back to the model. Define in `.deepcopilot/hooks.json`:

```json
{ "hooks": [
  { "event": "after_tool", "tool": "write_file",
    "run": "npm test", "on_failure": "inject_error", "timeout_ms": 30000 }
]}
```

**中文** 任意工具调用后自动执行脚本（如写文件后自动跑测试），输出注入模型上下文供其反应。

---

### 🧠 User Memory · 用户记忆

**EN** Drop a `~/.deepcopilot/memory.md` and your cross-project preferences (≤ 4 KB) get injected into every system prompt.

**中文** 在 `~/.deepcopilot/memory.md` 写入跨项目偏好（最多 4 KB），每次对话自动注入。

---

### ↩️ Revert Last Turn · 一键回滚

**EN** Undo all file changes from the current agent turn — via the model-callable `revert_last_turn` tool or the command palette: `Deep Copilot: Revert Last Turn`.

**中文** 一键撤销当前 Agent 轮次的全部文件改动（`revert_last_turn` 工具或命令面板）。

---

### 🩺 Post-Edit LSP Diagnostics · 编辑后 LSP 诊断

**EN** Every file edit attaches the current LSP errors/warnings to the tool result, so the model can self-correct without another round trip.

**中文** 每次文件编辑后自动附带 LSP 错误与警告，模型可据此自我修复。

---

### 🔎 Web Search / 🐚 Shell / 📂 File Tools

**EN** Built-in toolset stays minimal and predictable: `read_file`, `write_file`, `edit_file`, `run_command`, `shell`, `web_search` (Tavily), plus session compaction for long chats.

**中文** 内置工具集保持精简：文件读写、命令执行、终端、Tavily 网络检索，以及长对话自动 compact。

---

## Bug Fixes & Polish · 修复与打磨

- Rolled up all patch fixes from `v0.28.1` → `v0.28.14`.
- Tool executor: stricter argument validation and clearer error reporting back to the model.
- Agent loop: more robust streaming, cancellation, and recovery from partial tool calls.
- Webview: smoother rendering for code blocks, math (KaTeX), and long sessions.

---

## Configuration Quick Reference · 配置速查

| Setting | Purpose |
| --- | --- |
| `deepseekAgent.mcp.servers` | Register MCP stdio servers |
| `Deep Copilot: Set API Key` | Store DeepSeek key in SecretStorage |
| `Deep Copilot: Set Tavily API Key` | Enable `web_search` |
| `Deep Copilot: Switch API Base URL` | Point at a different provider endpoint |
| `~/.deepcopilot/memory.md` | Global user preferences |
| `.deepcopilot/hooks.json` | Project post-tool hooks |

---

## Full Changelog

https://github.com/ZhouChaunge/DeepCopilot/compare/v0.28.0...v0.30.0
