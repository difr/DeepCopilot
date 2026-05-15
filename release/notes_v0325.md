# Deep Copilot v0.32.5 Release Notes · 更新说明

---

## 🎉 What's New · 新功能

### 1. `web_fetch` Tool — Fetch any public URL · 获取任意公开网页

A brand-new tool that lets Deep Copilot fetch and read any public URL directly, complementing `web_search` (which returns summaries). Now the agent can inspect full page content, API responses, or documentation in detail.

全新工具 `web_fetch`，让 AI 代理可以直接获取并读取任意公开网页的内容，与 `web_search`（仅返回摘要）互补。代理现在可以查看完整页面内容、API 响应或详细文档。

---

### 2. Unlimited Iterations Mode (0 = ∞) · 无限迭代模式

`deepseekAgent.maxIterations` now defaults to **0**, meaning the agent runs until the task is done, guarded only by stagnation detection. Previously the hard cap was 15 iterations. You can still set a positive number to cap API costs on simple tasks.

`deepseekAgent.maxIterations` 现在默认值为 **0**，表示代理会一直运行直到任务完成，仅受停滞检测保护。之前的硬上限为 15 次迭代。你仍可以设置正数来在简单任务上限制 API 成本。

---

### 3. Smarter Context Compaction · 更智能的上下文压缩

Fixed a critical bug in the auto-compaction logic: the split point now properly walks backwards past tool result messages, ensuring tool-call groups are never broken in half. This prevents API errors where a tool result would appear without its paired assistant message.

修复了自动压缩逻辑中的一个关键 bug：分割点现在会正确地向后跳过工具结果消息，确保工具调用组永远不会被从中间截断。这防止了因工具结果消息没有配对的助手消息而导致的 API 错误。

---

### 4. Graceful Error Recovery · 优雅的错误恢复

Abort errors now produce shorter, cleaner messages. The agent recovers more gracefully from cancelled operations without noisy stack traces in the chat.

中止错误现在生成更短更清晰的消息。代理从取消的操作中恢复更加优雅，不会在聊天中留下混乱的堆栈跟踪。

---

### 5. Reliable Task Completion · 可靠的任务完成报告

A new "Task completion reply" rule in the system prompt ensures the agent **always** finishes with a plain-text summary of what was done, the outcome, and any next steps. No more ambiguous silent endings.

系统提示中新增了一条"任务完成回复"规则，确保代理**始终**以纯文本摘要结束，说明已完成的内容、结果和后续步骤。不再有模棱两可的无声结束。

---

### 6. Fixed README Emoji · 修复 README 表情符号

Fixed a broken emoji in the table of contents heading.

修复了目录标题中一个损坏的表情符号。

---

## 📦 Files Changed · 文件变更

| File · 文件 | Change · 变更 |
|---|---|
| `package.json` | v0.32.0 → v0.32.5; `maxIterations` default 15→0, max 64→200 |
| `src/chat/agent-loop.js` | Cleaner abort error handling |
| `src/chat/compact.js` | Fixed tool message group split bug |
| `src/chat/tool-executor.js` | Added `web_fetch` registration & caching |
| `src/prompts/system.js` | Added "Task completion reply" rule |
| `src/tools/exec.js` | Export `toolWebFetch` |
| `src/tools/schema.js` | Added `web_fetch` tool schema definition |
| `README.md` | Fixed broken emoji |
| `release/notes_v028.md` ~ `notes_v0310.md` | Cleaned up old notes |

---

## ⬇️ Download · 下载

**VSIX Package**: `release/deep-copilot-0.32.5.vsix`

Install via VS Code: `Extensions > ... > Install from VSIX...`

通过 VS Code 安装：`扩展 > ... > 从 VSIX 安装...`

---

*Built with ❤️ by ZhouChaunge · 用心打造*
