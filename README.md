# Deep Copilot

<p align="center">
  <img src="imgs/main_logo.png" alt="Deep Copilot" width="100%"/>
</p>

<p align="center">
  <b>A VS Code extension for conversational AI-assisted coding via the DeepSeek API</b>
</p>

<p align="center">
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-%E2%89%A51.95.0-blue" alt="VS Code"/></a>
  <a href="https://github.com/ZhouChaunge/DeepCopilot/releases"><img src="https://img.shields.io/github/v/release/ZhouChaunge/DeepCopilot?label=version&color=success" alt="Version"/></a>
  <a href="https://github.com/ZhouChaunge/DeepCopilot/stargazers"><img src="https://img.shields.io/github/stars/ZhouChaunge/DeepCopilot?style=flat&color=yellow" alt="GitHub stars"/></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ZhouChaunge.deep-copilot"><img src="https://img.shields.io/visual-studio-marketplace/i/ZhouChaunge.deep-copilot?label=installs&color=brightgreen" alt="VS Marketplace Installs"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"/></a>
</p>

> Deep Copilot is a VS Code extension that provides LLM-based conversational coding assistance through the sidebar. It interacts with models via the DeepSeek API (OpenAI-compatible protocol), supporting tool calls for file read/write, code search, and shell command execution — all streamed in real time. The extension has no runtime npm dependencies and is built on the VS Code Extension API and Node.js built-ins; no additional service deployment is required.

---

## 🔑 API Keys Required

You only need the following keys to get started — at minimum just the first one:

| # | API Key | Purpose | Get it here | Required |
| --- | --- | --- | --- | --- |
| 1 | **DeepSeek API Key** | Powers all AI chat & agent tool calls | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) | Required |
| 2 | **Tavily API Key** | Enables the `web_search` tool | [app.tavily.com](https://app.tavily.com) | Optional |

### How to set them

1. After installing, click the 🐋 icon in the activity bar to open the Deep Copilot panel
2. Click the 🔑 button in the **bottom-right** of the panel → paste your **DeepSeek API Key** → save
3. For web search, fill in your **Tavily API Key** in the same dialog

> China users: if `api.deepseek.com` is slow, set Base URL to `https://api.deepseeki.com` in the 🔑 dialog.

---

## 📑 Table of Contents

- [🔑 API Keys Required](#-api-keys-required)
- [✨ Highlights](#-highlights)
- [🚀 Quick Start](#-quick-start)
- [🛠 Build from Source](#-build-from-source)
- [⚙️ Configuration](#-configuration)
- [⌨️ Keybindings](#-keybindings)
- [🧰 Tools](#-tools)
- [🏗️ Architecture](#-architecture)
- [📁 Project Structure](#-project-structure)
- [💻 Development](#-development)
- [🔧 Troubleshooting](#-troubleshooting)
- [📜 Changelog](#-changelog)
- [📄 License](#-license)
- [⭐ Star History](#-star-history)

---

## ✨ Highlights

| Feature |
| --- |
| **Agentic loop** with multi-turn tool calling on DeepSeek V4 (Pro / Flash / Reasoner) |
| **File tools**: read, write, str-replace, apply_patch, list dir, find files, ripgrep search |
| **Shell tool** with configurable approval policy |
| **Web search** via Tavily (optional API key) |
| **Plan & Todos** panel — agent maintains a structured plan you can watch tick off |
| **Revert last turn** — one-click rollback of all file edits in the current agent turn |
| **Pending edits panel** — GH-Copilot-style review popover above the composer: per-file `+N/-M`, hover Keep/Discard, click row to open native diff editor; survives turn end |
| **User memory** (`~/.deepcopilot/memory.md`) — cross-project preferences in every system prompt |
| **MCP client** — connect any MCP-compatible tool server via `deepseekAgent.mcp.servers` |
| **Post-tool hooks** — run scripts after any tool call; output injected into model context |
| **Post-edit LSP diagnostics** appended to every edit so the model can self-verify |
| **Per-workspace session history** with search, rename, delete |
| **Parallel sessions** — switch away from a running task and start another; live replay on return |
| **Streaming output** with reasoning expander, blinking cursor, top progress bar |
| **HTML rendering** — model responses render full Markdown + HTML; math via KaTeX |
| **Account balance** display in footer (click to refresh) |
| **Auto-grow input** — textarea grows with content, GH Copilot style |
| **Approval modes**: Manual / Auto-Edit / Autopilot / Read-Only |
| **Cost telemetry** in CNY shown in the footer |
| **Slash commands** (`/explain`, `/fix`, `/tests` …), **`@` file refs** and **`#` context refs** — pick `#file`, `#selection`, `#editor`, `#problems`, `#changes`, `#terminal`, `#symbol:Foo`, `#fetch:URL` from the input |
| **Smart code-block actions**: Run in terminal · Insert · Copy · Fold long blocks |
| **English-only UI** — every user-visible string lives in `src/utils/strings.js` |
| **Skills system** — define reusable SKILL.md packs in `~/.deepcopilot/skills` (or `~/.claude/skills`, `~/.copilot/skills`); YAML frontmatter for workspace gating, invoke via `/skill` or the model's `skill_invoke` tool |
| **Inline FIM completions** — DeepSeek ghost-text suggestions as you type; `Tab` to accept; off by default (`deepCopilot.inlineCompletion.enable`) |
| **Plan mode** — read-only investigation mode; agent can read/search but never write or run shell commands |
| **Ecosystem AI-rule discovery** — auto-injects `DEEPCOPILOT.md`, `.github/copilot-instructions.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `CLAUDE.md` |
| **Context window management** *(new in 0.41.0)* — structure-aware truncation, per-file dedup, rolling summary; `/compact [focus]` force-compacts, `/context` opens a token breakdown, `/fork [name]` branches a new session from any message |
| **Footer context ring** *(new in 0.41.0)* — ring indicator next to the footer ramps green → yellow → orange → red across 60 / 85 / 100% thresholds; click to open the same breakdown as `/context` |
| **Archive = pure export** *(updated in 0.41.6)* — "Archive" now writes a Markdown snapshot under `.deep-copilot/archives/` and **leaves the session alone**; old soft-hidden sessions are auto-unarchived on first launch |
| **Watchdog turns stay on duty** *(new in 0.41.6)* — when the agent monitors a long-running background job (training, build, dev server) via `read_terminal`, the turn refuses to end until the job finishes or the 4 h per-turn budget elapses |

---

## 🚀 Quick Start

### Option 1 — VS Code Marketplace

1. Open VS Code → Extensions (`Ctrl/Cmd+Shift+X`) → Search **Deep Copilot** → Install.

### Option 2 — Install the prebuilt VSIX

```bash
# https://github.com/ZhouChaunge/DeepCopilot/releases

code --install-extension deep-copilot-0.41.6.vsix
```

Or in VS Code: **Extensions** view → `⋯` menu → **Install from VSIX...** and pick the file.

### Step 2 — Set the API key

1. Click the 🐋 Deep Copilot icon in the **activity bar** to open the chat panel.
2. Click the 🔑 button at the **bottom right** of the panel, paste your [DeepSeek API key](https://platform.deepseek.com/api_keys).
3. Start chatting!

---

## 🛠 Build from Source

### Prerequisites

| Tool | Version | Note |
| --- | --- | --- |
| **Node.js** | ≥ 18 | esbuild + vsce |
| **npm** | ≥ 9 | comes with Node |
| **VS Code** | ≥ 1.95 | extension host |
| **Git** | any | optional, to clone |

### Steps

```bash
# 1. Clone the repo
git clone https://github.com/ZhouChaunge/DeepCopilot.git
cd DeepCopilot

# 2. Install dependencies
#    (only devDependencies: esbuild + vsce + @types — runtime is pure VS Code API)
npm install

# 3. Build the bundle
npm run build
# -> outputs out/extension.js (~105 KB minified)

# 4. Package as VSIX
npm run package
# -> outputs deep-copilot-0.41.6.vsix

# 5. Install locally
code --install-extension deep-copilot-0.41.6.vsix --force
```

### Watch mode

```bash
npm run watch
# Rebuilds out/extension.js on every src/ change.
# Then: F5 in VS Code (with the repo opened) launches the Extension Development Host.
```

### What gets built

| Path | Tracked? | Purpose |
| --- | --- | --- |
| `src/` | ✅ yes | Source modules (entry: `src/extension.js`) |
| `media/` | ✅ yes | Webview assets (chat.css / chat.js / icons) |
| `esbuild.config.js` | ✅ yes | Bundler config |
| `package.json` | ✅ yes | Manifest + scripts |
| `package-lock.json` | ✅ yes | Locked dep versions |
| `out/extension.js` | ❌ ignored | Built bundle (regenerated by `npm run build`) |
| `release/*.vsix` | ❌ ignored | Packaged extension (regenerated by `npm run package`) |
| `node_modules/` | ❌ ignored | npm cache |

> Everything required to compile is in the repo. `out/` and `*.vsix` are reproducible artifacts.

---

## ⚙️ Configuration

Chat, tool and shell settings live under the `deepseekAgent.*` namespace in
`settings.json`; editor completions live under `deepCopilot.*`.

| Setting | Default | Description |
| --- | --- | --- |
| `deepseekAgent.provider` | `deepseek` | Active provider preset (auto-fills the Base URL in the settings UI) |
| `deepseekAgent.apiBaseUrl` | *(empty → provider endpoint)* | AI provider Base URL; overrides the provider's built-in endpoint |
| `deepseekAgent.providersDir` | *(empty)* | Directory with extra provider JSON files (same schema as the built-ins) |
| `deepseekAgent.defaultModel` | *(empty → provider default)* | Chat model override |
| `deepseekAgent.subAgentModel` | *(empty → provider `subAgentModel`)* | Model used by `spawn_agent` sub-agents |
| `deepseekAgent.approvalMode` | `manual` | Tool approval policy for `write_file` / `run_shell` |
| `deepseekAgent.fastThinking` | `false` | Fold reasoning (Thinking) sections while a turn runs: they appear collapsed and their text is not rendered per delta. Click a section to expand it |
| `deepseekAgent.interactionMode` | `agent` | `agent` (full tools) / `ask` / `plan` (read-only) |
| `deepseekAgent.autoApproveTools` | `[]` | Tool names to always auto-approve |
| `deepseekAgent.denyTools` | `[]` | Tool names to always deny |
| `deepseekAgent.includeMcpTools` | `true` | Include MCP tools in every request |
| `deepseekAgent.shellExecutionMode` | `silent` | `silent` hidden subprocess / `terminal` integrated terminal |
| `deepseekAgent.maxIterations` | `0` | Max tool-call rounds per send; `0` = unlimited |
| `deepseekAgent.compactBudgetTokens` | `0` | Explicit compaction token budget; `0` = derive it from the model window |
| `deepseekAgent.compactBudgetShare` | `0.75` | Share of the model window used as the budget when `compactBudgetTokens` is `0` |
| `deepseekAgent.compactMaxMessages` | `1200` | Message count that triggers compaction regardless of tokens; the cut takes `keepTail / maxMessages` of the current size |
| `deepseekAgent.compactKeepTail` | `300` | Messages kept verbatim when the head of the history is summarised |
| `deepseekAgent.compactHardLimitShare` | `0.9` | Emergency ceiling as a share of the model window (avoids HTTP 400) |
| `deepseekAgent.postEditDiagnostics` | `true` | Append LSP diagnostics after every file edit |
| `deepseekAgent.autoResumeMaxPerHour` | `12` | Auto-resumes per session per hour (background wake scheduler) |
| `deepseekAgent.webSearchProvider` | `auto` | `auto` / `tavily` / `duckduckgo` / `bing` |
| `deepseekAgent.terminal.captureHistory` | `true` | Let `read_terminal` read the integrated terminal's recent output |
| `deepseekAgent.contextRefs.terminalUseClipboard` | `false` | Let `#terminal` capture the selection through the clipboard |
| `deepseekAgent.enableDebugLog` | `true` | Log thoughts / tool calls / API events to `.deep-copilot/logs/` |
| `deepseekAgent.fileEncoding` | `{}` | Per-glob encoding overrides for non-UTF-8 files |
| `deepseekAgent.serverExecutablePath` | *(empty)* | Backend executable path — unused in standalone mode |
| `deepseekAgent.serverPort` | `8787` | Backend API port — unused in standalone mode |
| `deepseekAgent.mcp.servers` | `[]` | MCP server list (see MCP section below) |

Inline (ghost-text) completions have their own namespace:

| Setting | Default | Description |
| --- | --- | --- |
| `deepCopilot.inlineCompletion.enable` | `false` | Enable DeepSeek FIM-powered inline completions |
| `deepCopilot.inlineCompletion.model` | `deepseek-flash` | Model used for FIM completions |
| `deepCopilot.inlineCompletion.debounceMs` | `300` | Idle delay (ms) before requesting a completion |
| `deepCopilot.inlineCompletion.maxTokens` | `256` | Maximum tokens per inline completion |
| `deepCopilot.inlineCompletion.baseUrl` | *(empty → DeepSeek default)* | Optional Base URL for FIM completions |

### Approval Modes

| Mode | Behavior |
| --- | --- |
| **manual** | Prompt every `write_file` / `run_shell` (safest, default) |
| **auto-edit** | Auto-approve writes; still prompt for shell |
| **autopilot** | Auto-approve everything (trusted workspaces only) |
| **readonly** | Deny all writes & shell |

> Issue #89 — In `autopilot` mode, shell calls matching the dangerous-command regex (`rm -rf`, `git reset --hard`, `git push --force`, …) are silently allowed and written to the `SHELL_DANGER_AUTO_APPROVE` audit log instead of showing a modal. In other modes, the same command is cached for the session after a single approval. Adding `run_shell` to `autoApproveTools` is equivalent to explicitly accepting shell risk — only enable it in trusted workspaces.

---

## ⌨️ Keybindings

| Key | Action |
| --- | --- |
| `Ctrl/Cmd+Shift+D` | Open sidebar |
| `Ctrl/Cmd+Shift+L` | Open in tab |
| `Enter` | Send message |
| `Shift+Enter` | Newline |
| `Esc` | Stop generation |
| `Ctrl/Cmd+K` | Clear current chat |
| `↑` / `↓` (empty input) | Recall prompt history |
| `↑` / `↓` (slash menu open) | Navigate suggestions |
| `Tab` / `Enter` (slash menu) | Apply suggestion |

---

## 🧰 Tools

Deep Copilot exposes a small, deliberately-minimal tool set to the model:

| Tool | Description |
| --- | --- |
| `read_file` | Read part or all of a file, optional line range |
| `write_file` | Create or overwrite a file (approval-gated) |
| `str_replace_in_file` | Targeted in-place edit by exact string match |
| `apply_patch` | Apply a unified-diff patch (multi-hunk, multi-file) |
| `list_dir` | List directory entries (depth-limited) |
| `find_files` | Find files by name or glob pattern |
| `grep_search` | Ripgrep-style regex search across the workspace |
| `diff_files` | Unified diff between two files or directories |
| `get_diagnostics` | Language-server errors and warnings for a file or the workspace |
| `get_editor_context` | Active file, language, cursor, selection and open tabs |
| `find_references` | All usages of a symbol (LSP) |
| `go_to_definition` | Where a symbol is defined (LSP) |
| `run_shell` | Run a shell command (approval-gated) |
| `run_shell_bg` | Run a long-running command in the background with live output |
| `read_terminal` | Read the recent output of a VS Code integrated terminal |
| `web_search` | Search the web (Tavily / DuckDuckGo / Bing) |
| `web_fetch` | Fetch a URL and return it as plain text |
| `fetch_top` | Search, then fetch the content of the top results |
| `update_plan` | Push / update the structured plan & todos panel |
| `save_plan` | Persist a Plan-mode investigation to `.deep-copilot/plans/` as Markdown |
| `revert_last_turn` | Restore all files to their pre-turn state |
| `memory_read` | Read `.deep-copilot/memory.md` |
| `memory_write` | Persist a project fact or convention to `.deep-copilot/memory.md` |
| `git_status` | Working-tree status and current branch |
| `git_diff` | Diff of unstaged (or staged) changes |
| `git_log` | Recent commit history, one line per commit |
| `spawn_agent` | Launch an isolated sub-agent with its own context |
| `skill_invoke` | Load a locally-installed skill SOP into context |
| `skill_create` | Persist a reusable workflow as a new skill |
| `watch` | Register a trigger that auto-resumes this conversation later |
| `yield_turn` | End the current turn so a watcher can resume it |
| `mcp__<server>__<tool>` | Any tool exposed by a connected MCP server |

> Tool definitions live in [`src/tools/schema.js`](src/tools/schema.js); execution in [`src/tools/exec.js`](src/tools/exec.js).

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  VS Code Extension Host                  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ src/extension.js  (activate / commands)            │  │
│  └────────────────────────────────────────────────────┘  │
│                          │                               │
│                          ▼                               │
│  ┌────────────────────────────────────────────────────┐  │
│  │ src/chat/provider.js  (ChatViewProvider)           │  │
│  │   • Webview ↔ Extension message bus                │  │
│  │   • Per-session run map  (parallel sessions)       │  │
│  │   • Persisted history    (globalState)             │  │
│  │   • Plan / Todos state                             │  │
│  └────────────────────────────────────────────────────┘  │
│            │                            │                │
│            ▼                            ▼                │
│  ┌──────────────────┐        ┌────────────────────────┐  │
│  │ src/api/         │        │ src/tools/             │  │
│  │  deepseek.js     │        │  schema.js  (defs)     │  │
│  │  • SSE streaming │        │  exec.js    (runtime)  │  │
│  │  • Tool calls    │        │  • read/write/list     │  │
│  │  • Reasoning     │        │  • grep / shell        │  │
│  └──────────────────┘        │  • approval gating     │  │
│                              └────────────────────────┘  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ src/webview/html.js   (HTML shell injected)        │  │
│  │ media/chat.js + chat.css   (UI runtime + styles)   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                          │  HTTPS (SSE)
                          ▼
              ┌────────────────────────┐
              │  DeepSeek Platform     │
              │  api.deepseek.com      │
              │  (OpenAI-compatible)   │
              └────────────────────────┘
```

### Key design points

- **No backend.** Everything runs inside the VS Code extension host. The single bundle `out/extension.js` is roughly 105 KB minified.
- **Per-session run map.** `provider._runs: Map<sessionId, Run>` lets you switch sessions while a task is running; the run keeps producing events that get buffered and replayed when you return.
- **Streaming via SSE.** `src/api/deepseek.js` parses `data:` frames and forwards `delta`, `reasoning`, `tool_calls`, `usage` to the provider.
- **Auto-compaction.** History grows to `compactMaxMessages` and is compacted back to `compactKeepTail`, leaving the recent tail byte-identical so the provider's prefix cache stays warm. The token trigger compares the expected prompt size (the reported fact plus the growth since it, in provider units) against the budget — never a raw character estimate. A count-only fire has no token pressure to satisfy, so it takes `compactKeepTail / compactMaxMessages` of the current size as its budget, and both triggers then shrink to the same share. The panel keeps that summary as a card — the number of turns folded into it, plus the body itself, collapsed — and drops every turn older than it, so the visible history and the context the model receives stay in step.
- **Approval is enforced server-side (in the extension), not just UI.** A model-issued `write_file` will not execute unless the policy or user explicitly allows it.

---

## 📁 Project Structure

```
.
├── esbuild.config.js          # esbuild bundler config
├── package.json               # extension manifest + scripts
├── package-lock.json          # locked deps
├── README.md                  # this file
├── LICENSE                    # MIT
├── media/                     # webview assets (loaded as static files)
│   ├── chat.css               #   ↳ all UI styles
│   └── chat.js                #   ↳ webview runtime (markdown, tool cards, streaming)
├── imgs/
│   ├── main_logo.png          #   ↳ README banner
│   ├── logo_black_bg.png      #   ↳ extension icon + webview logo
│   ├── logo_black_bg.svg      #   ↳ activity bar icon (vector)
│   ├── logo.png               #   ↳ marketplace icon (white background)
│   ├── logo_white_bg.svg      #   ↳ activity bar icon (white variant)
│   ├── logo_white_bg.png      #   ↳ logo (base)
│   └── screenshot.png         #   ↳ README screenshot
└── src/                       # extension source
    ├── extension.js           #   ↳ activate() entry
    ├── errors.js              #   ↳ error → friendly error card
    ├── logger.js              #   ↳ debug log writer (.deep-copilot/logs/)
    ├── pricing.js             #   ↳ token → CNY cost calculator
    ├── hooks.js               #   ↳ post-tool hooks runner (.deepcopilot/hooks.json)
    ├── mcp.js                 #   ↳ MCP stdio client (McpClient + McpManager)
    ├── api/
    │   └── deepseek.js        #   ↳ SSE chat client (OpenAI-compatible)
    ├── chat/
    │   ├── provider.js        #   ↳ ChatViewProvider (the brain)
    │   ├── diff-utils.js      #   ↳ +N/-M line diff for the pending-edits panel
    │   └── openFile.js        #   ↳ "open file at line" helper
    ├── prompts/
    │   └── system.js          #   ↳ system prompt builder (+ DEEPCOPILOT.md + user memory)
    ├── tools/
    │   ├── schema.js          #   ↳ tool JSON-schema definitions
    │   └── exec.js            #   ↳ tool runtime (file IO, ripgrep, shell)
    ├── utils/
    │   ├── strings.js         #   ↳ English UI strings + t()/tf() accessors
    │   └── paths.js           #   ↳ path safety / workspace root resolution
    └── webview/
        └── html.js            #   ↳ generates the webview HTML shell
```

> Build entry: `src/extension.js` → esbuild → `out/extension.js` (referenced by `main` in `package.json`).

---

## 💻 Development

### Run the dev host

```bash
git clone https://github.com/ZhouChaunge/DeepCopilot.git
cd DeepCopilot
npm install
code .
# Press F5 inside VS Code → Extension Development Host opens
```

### Live edit cycle

```bash
npm run watch   # esbuild watch — rebuilds on save
# In the dev host: Ctrl+R / Cmd+R reloads the window after a rebuild
```

### Debug logs

- Output panel → **Deep Copilot** channel
- Or open via command palette: `Deep Copilot: Open Debug Log`
- Files: `<workspace>/.deep-copilot/logs/session-*.log`

### Workspace-specific instructions

Create a `DEEPCOPILOT.md` at the workspace root and Deep Copilot will inject its content into the system prompt for every request in this workspace — useful for project conventions, build commands, "do/don't" lists.

### User memory

Create `~/.deepcopilot/memory.md` for cross-project preferences that apply everywhere — preferred coding style, always/never rules, personal shortcuts. It is injected (capped at 4 KB) into every system prompt.

### MCP servers

Add external tool servers via VS Code settings:

```json
"deepseekAgent.mcp.servers": [
  { "name": "my-db", "command": "npx", "args": ["my-db-mcp-server"] }
]
```

Tools appear as `mcp__my-db__<toolName>` alongside built-in tools. Any MCP-compatible stdio server works.

### Post-tool hooks

Create `.deepcopilot/hooks.json` in your workspace:

```json
{ "hooks": [
  { "event": "after_tool", "tool": "write_file",
    "run": "npm test", "on_failure": "inject_error", "timeout_ms": 30000 }
]}
```

The hook's stdout/stderr is appended to the tool result so the model can react — e.g., auto-fix test failures immediately after writing a file.

### Style & conventions

- Plain JavaScript (no TypeScript) — keep the bundle tiny.
- No runtime dependencies — only VS Code API + Node built-ins.
- Webview side communicates via `postMessage`; never imports `vscode`.

---

## 🔧 Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Set your API key first` toast | Click 🔑 in the bottom-right of the panel |
| 401 / 403 errors | Key invalid or revoked — regenerate at platform.deepseek.com |
| 402 errors | Account out of balance — top up |
| 429 errors | Rate-limited; retry button is shown on the error card |
| Connection timeouts in mainland China | Switch base URL to `https://api.deepseeki.com` |
| UI still shows "Thinking..." | Old VSIX still installed — install the new one with `--force` |
| Tools not being called | You may be in `Ask` mode — switch to `Agent` in the header |
| Hangs mid-task | Click ⏹ Stop or press `Esc`; check Debug Log |
| Status bar "Deep Copilot" missing | Right-click the status bar → enable "Deep Copilot" |

---

## 📜 Changelog

<details>
<summary>Click to expand full changelog</summary>

### v0.41.6 — Archive as pure export · Watchdog turns stay on duty

- ①**Issue #169 — Archive becomes pure export**: clicking "Archive" only writes a Markdown snapshot under `.deep-copilot/archives/` and leaves the session completely untouched (no more soft-hide, no more current-session-swap, clicking twice on the same session simply produces two snapshots); failure paths and save-dialog cancellation no longer mutate `archived` state. A one-shot idempotent migration `_migrateArchivedFlagIfNeeded` (guarded by `globalState['deepseekAgent.archiveSemanticsV2Migrated']`) flips every legacy `archived: true` session back to `false` on first launch so previously-hidden sessions reappear in the sidebar. Failure routes through `Logger.info('ARCHIVE_V2_MIGRATION_FAILED', ...)` instead of blocking activation. ②**Watchdog turn stays on duty**: when a background job (training, build, dev server) was started in an earlier turn, `run._sessionStartedBgJobs` is empty in the current turn, so the `BG_WAIT_SKIPPED_MODEL_DONE` guard used to terminate the conversation right after the model promised to keep monitoring. The agent now tracks every `deepseek-job-*` terminal the model inspects via `read_terminal` in `run._monitoredBgJobs`; the agent-loop guard refuses to end the turn while any such monitored job is still alive, so the loop keeps polling and emitting 4-minute snapshots until the job finishes or the 4 h per-turn budget elapses. ③Routes migration failures through `Logger` (replacing `console.warn`) so diagnostics respect `deepseekAgent.enableDebugLog` and surface in the "Deep Copilot Debug" output channel. ④`.vscodeignore` now filters `.tmp-*.json/.txt/.md`, preventing local PR-review scratch caches from accidentally leaking into the shipped VSIX.

### v0.41.0 — Context window management · Footer context ring

- ①**Issue #142 — context-window overhaul**: structure-aware truncation (latest tool results kept verbatim, older turns collapsed to summary skeletons); per-file dedup (multiple reads of the same path keep only the latest payload; earlier ones become `<file path=... read-collapsed='true'/>` placeholders); rolling-summary fallback that compresses older history into structured summary nodes when thresholds are crossed; MCP tools support per-server explicit opt-out; large-file reads now ship a `read-large-file` hint nudging the model to grep first. ②**Three new slash commands**: `/compact [focus]` force-compacts the active session (focus biases the summarisation; merges project-level `.deepcopilot/compact.md` / `CLAUDE.md` hints); `/context` opens a breakdown popover (system / messages / tools / files / hints); `/fork [name]` forks the current session from a message into a brand-new one with that context as origin. ③**Footer context ring**: replaces the legacy status dot with a ring indicator (`#ft-ctx`) whose colour ramps green → yellow → orange → red across 60/85/100% thresholds; click opens the same breakdown shown by `/context`. ④**Issue #143 — session-switch flash / scrollbar jitter**: switching away from and back to a running session previously replayed buffered events in a tight loop, each one scheduling its own RAF scroll-to-bottom. Fix: `_loadSession` defers replay via `setTimeout(..., 0)` and wraps the burst with `replayStart` / `replayEnd` envelopes; the webview adds a `_replaying` flag that silences `ascroll()` during the burst and performs a single final scroll on `replayEnd`. ⑤Minor cleanups in the Anthropic / OpenAI clients, `errors.js` copy tweaks, `file-read.js` large-file notice, and `session-store.js` adapts to persist / replay rolling-summary nodes correctly.

### v0.40.4 — Pending edits panel

- ①**New "Pending edits" panel**: inspired by GitHub Copilot in VS Code. A popover sits above the composer and lists every file the agent just wrote/patched/replaced, with per-file `+lines / -lines` stats and `new` / `deleted` / `binary` tags. ②**Click → native diff editor**: clicking any row opens the real VS Code diff editor — left side is the pre-edit snapshot served by a `deepcopilot-before:` `TextDocumentContentProvider`, right side is the current on-disk content. URIs carry a cache-busting timestamp and the provider fires `onDidChange`, so repeat clicks always re-open. ③**Per-row & bulk actions**: hover reveals ✓ (Keep) and ✕ (Discard); the header offers "Keep all / Discard all". Discard restores from snapshot; Keep simply removes the row. ④**Survives turn end**: `pendingEdits` is now keyed by session rather than by run, so even after AgentLoop reaps the run at end-of-reply, the panel rows remain clickable until you Keep/Discard them — matching the Copilot UX. ⑤**Lightweight line diff**: new `src/chat/diff-utils.js` computes `+N/-M` via LCS, with a graceful fallback for files >10k lines or >100k chars and a binary-safety guard so PNGs etc. just get a `binary` tag instead of garbled counts. ⑥**Aligned with existing Undo**: `revert_last_turn` and the status-bar revert button also clear the pending-edits panel, so there are no orphan entries. ⑦**CSP / safety**: webview CSP unchanged; the content provider only returns in-memory snapshots and never touches paths outside what was already captured.

### v0.40.0 — UI visual refresh · Terminal early-exit · Packaging cleanup

- ①**Chat UI visual refresh**: introduced design tokens `--dc-indent / --dc-fg-* / --dc-accent / --dc-rule`; eight container types now share one "2px left rule + 16px indent" rhythm — `.tool` card headers, `.tl` tool rows, `.tl-detail` panels and `.tool .b` body are visually aligned, dramatically reducing noise. ②**Tool-type color rails**: new `k-read / k-write / k-search / k-shell / k-agent / k-plan / k-other` accent classes so different tools are distinguishable at a glance; `.tl-group .tl-summary` adopts the same 2px rail. ③**Thinking-block UX**: as soon as the model starts streaming the reply, the thought block auto-collapses with a `Thought for Ns` summary while keeping the header visible for on-demand review. ④**Chip semantics**: tool-name chip changed from `<span>` to `<code>` to align with monospace body text. ⑤**Output style contract**: system prompt gains a new "Output style contract" section governing monospace usage, list semantics, paragraph control, and banning decorative emoji — markdown output is far more consistent. ⑥**Terminal early-exit window**: `run_shell_bg` now races the spawn against a 2.5 s capture window — if the command crashes/exits inside the window, the real `exit_code` + output are returned **synchronously**, so the model sees failures immediately instead of "giving up" after a fire-and-forget submission; on timeout, the original async `running` path takes over. `terminal-monitor` exposes `markSyncReturnedJob/wasSyncReturned` to deduplicate the late `bg-job-end` event so the agent loop never re-injects what was already returned synchronously. ⑦**`.vscodeignore` cleanup**: removed 14 stale rules (deleted `test/` `data/` `models/` `runs/` directories and a batch of `.pt` weights), added `.github/**` `.eslintrc.json` `.gitleaksignore`, and grouped/commented the file by purpose — vsix payload is leaner.

### v0.35.2 — Explorer attach · read_terminal · Verification loop · save_plan

- ①**Explorer context-menu attach**: right-click any file or folder in VS Code Explorer → "Attach to Deep Copilot" injects its content or directory tree as a chip into the chat input. Files auto-truncated at 64 KB; folders walked recursively (max depth 3, max 200 entries; `node_modules` / `.git` / `dist` etc. skipped). ②**`read_terminal` tool**: the model can proactively read the latest output of the VS Code integrated terminal without the user manually copy-pasting; supports filtering by terminal name; output auto-truncated with sensitive paths sanitised. ③**Agent proactive verification loop**: after critical writes or shell commands, the agent automatically emits a follow-up tool call to verify the result (e.g. re-read a file to confirm content, or run tests); `run_shell` result is structured as `{exit_code, stdout, stderr}` so the model can branch on success/failure. ④**`save_plan` tool**: at the end of a Plan-mode investigation, the structured plan (title, goal, steps, files, risks) is persisted to `.deep-copilot/plans/` as a timestamped Markdown file. ⑤**Context-chip auto-attach current file**: when an editor file is focused, its path appears as a chip in the input bar; chip updates live as the active file changes; chip is preserved (no longer cleared) when focus moves to the chat panel. ⑥Fixes: skill SKILL.md path resolution across home / workspace directories; tool-card borders replaced with theme-aware `var(--vscode-panel-border)`; tool header status bar restored; Composer top separator removed.

### v0.35.0 — Skills · FIM inline completions · Plan mode · Rule discovery

- ①**Skills upgrade**: three-directory scan, YAML frontmatter (`name`/`description`/`applies_to` workspace gating), stable alpha sort, new `skill_invoke` tool for on-demand model-side loading, `/skill <name>` slash command for manual invocation. ②**DeepSeek FIM inline completions**: ghost-text suggestions using surrounding context (4,000 chars prefix / 2,000 chars suffix) after ~350 ms idle; `Tab` to accept; off by default (`deepCopilot.inlineCompletion.enable`); silent failure; auto-cancel on next keystroke; sanitised error logs. ③**Plan read-only mode**: new Plan option in the mode selector; system prompt gains a read-only constraint — only read/search tools permitted; any write/shell call returns a tool error; ideal for investigation before editing. ④**Ecosystem AI-rule discovery**: on startup, scans `DEEPCOPILOT.md`, `.github/copilot-instructions.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, `CLAUDE.md` and injects all found content into the system prompt (capped at 8 KB). ⑤**AUTOCOMPACT persistent notice**: when auto-compaction fires, a permanent in-chat card is inserted so users understand why older tool outputs may be gone. ⑥Fixes: autopilot skips danger-cmd modal with per-session cache; shell heartbeat + SIGKILL fallback; orphan tool-message HTTP 400 self-heal; IME composition Enter guard.

### v0.34.0 — `#` Context-Reference Picker

- Typing `#` in the chat input opens a context-reference picker. One-click attach: `#file` (any workspace file), `#selection` (active selection), `#editor` (active file), `#problems` (diagnostics), `#changes` (unstaged `git diff`), `#terminal` (selected terminal text), `#symbol:Foo` (workspace symbols), `#fetch:URL` (web fetch). All refs ride as `<attachment path="…">` blocks with synthetic paths (`<problems>`, `<git-changes>`, `<symbol:Foo>`, `<fetch:URL>`) so the model can tell them apart from real files. Inline `#ref:arg` tokens are resolved race-free on the extension side before the agent loop runs. SSRF blocklist enforced for `#fetch`; workspace-containment check for `#file` / `#editor`.

### v0.33.0 — Compact Tool UI · Sonar Spinner Redesign

- Heavily simplified tool-call display — icons, chevrons, and column layout removed in favour of a single-line grey text row with faded file paths and click-to-expand detail. Removed elapsed-time labels from all intermediate "Thinking" chips. Completely redesigned the bottom progress indicator: keeps the blue sonar dot, removes background / border / shimmer, adds a 20-word English verb carousel (randomised every 3 s with a fade-in animation) and a live elapsed timer. Fixed the spinner being obscured by the input box during long streaming responses via `requestAnimationFrame`-deferred scrolling and a per-second scroll safety net.

### v0.32.9 — Silent pass-through for out-of-workspace paths

- `ensurePathAllowed()` in `src/tools/utils.js` now checks the approval mode. In `autopilot`, paths outside the workspace (e.g. `~/.deepcopilot/memory.md`) are silently allowed and cached for the session, eliminating the previous dialog. `manual` / `auto-edit` behaviour is unchanged.

### v0.32.8 — Allow agent to launch desktop applications

- Added an explicit positive clause to the Using-tools section of the system prompt that declares `run_shell` has full OS-level access, with platform-specific launchers (`Start-Process`, `open`, `xdg-open`). Fixes the regression where the agent refused to attempt launching desktop apps in autopilot mode (`tool_calls=0`).

### v0.32.7 — Locale-Aware Fonts & Full Webview i18n

- **Locale-aware font switching**: on startup, reads `vscode.env.language`; `zh-*` locales use a CJK-optimised font stack (Microsoft YaHei UI / PingFang SC / Noto Sans CJK SC, with Linux fallback), all other locales use a Latin-optimised stack (Segoe UI / Inter / system-ui). Implemented via `html[data-locale]` CSS attribute selectors — zero bundle-size increase.
- **Full webview i18n**: all 20 hardcoded Chinese strings in the webview HTML template (welcome subtitle, input placeholder, session panel labels & buttons, empty-state text, thinking indicator, all tooltips) now route through the existing `t()` i18n system. English VS Code users see a fully English interface.

### v0.32.0 — Unified API Settings UI

- **One-click access to all API keys**: clicking the 🔑 button now opens a unified QuickPick panel with three items — **DeepSeek API Key (required)**, **Tavily API Key (optional)**, and **Base URL** — each showing live status, masked key preview, and inline help. The Tavily key, previously only accessible via the command palette, is now visible in the UI.
- **Status indicators**: codicon icons (`pass-filled` / `circle-large-outline`) show at a glance which keys are configured.
- **Looped UI**: after configuring one item, the panel returns automatically so users can set multiple keys without reopening.
- **README**: added an "API Keys Required" section near the top to help new users get set up faster.

### v0.31.6 — HTML Rendering Fixes · 1M Context Window

- **HTML inline tag whitelist expanded**: `SAFE_HTML_TAGS` now covers all common inline HTML elements — `strong`, `em`, `b`, `i`, `span`, `code`, `a`, `p`, `time`, `data`, `wbr`, `bdi`, `bdo`, `ruby`/`rt`/`rp`/`rb` and all previous tags. Model-output HTML inline tags no longer appear as escaped text.
- **Block-level heading tags** (`h1`–`h6`) added to the `HB_TAGS` extractor and DOMPurify `ADD_TAGS` — headings now render correctly instead of showing as raw HTML.
- **Fixed placeholder token ordering bug**: `HBRAW` blocks are now restored before `HTML` inline tokens, fixing the `HTML12ρHTML13` artefact that appeared when inline tags (`<var>`, `<sub>` etc.) were nested inside block elements (`<ul>`, `<div>` etc.).
- **1M context window support**: `COMPACT_BUDGET` raised to 600K, `MODEL_CTX_HARD_LIMIT` raised to 900K, and `max_tokens` raised to 32,768 — matching DeepSeek's actual 1M input / 384K output limits. Long conversations no longer hit the 60K hard cap that previously caused premature compaction.
- **System prompt updated**: `h1`–`h6` tags added to the safe HTML tag list; model instructed not to use inline `style=` attributes.

### v0.31.0 — Parallel Sub-Agents · Streaming Terminal Cards

- **`spawn_agent`**: launch isolated sub-agents with their own context; multiple sub-agent calls in the same turn now execute in parallel (Phase 1), matching `read_file` / `grep_search` behaviour.
- **Streaming terminal cards**: `run_shell`, `web_search`, `spawn_agent` outputs now render in expandable cards with live-streaming content.
- TLS keep-alive retry and large-file streaming safety improvements.

### v0.30.13 — Skill Notice UI Refactor

- **Skill notice bar**: `/skill` chip is now displayed as a dedicated blue pill inside the input row (outside the file-chip area), making the active skill always visible alongside the textarea.
- File attachment chips and skill chip are now rendered in separate DOM elements — no z-index conflicts, no invisible chips.
- Input row (`#inp-row`) wraps the skill notice and textarea as a flex row so both are always in view.

### v0.30.2 — Skill Discovery · Image Attachment · Asset Cleanup

- **Skill discovery**: scans `~/.claude/skills/` & `~/.copilot/skills/` for `SKILL.md` at startup; skills appear in the `/` slash-command menu.
- **Image attachments**: drag or click-attach PNG/JPG/GIF/WebP; thumbnail preview in chip bar; binary-file guard; multimodal `image_url` format sent to DeepSeek vision API.
- All logo/icon assets consolidated under `imgs/`; webview `localResourceRoots` updated.
- Auto-creates `~/.deepcopilot/skills/` directory on activation.

### v0.28.14 — UI Overhaul

- **New branding**: white whale logo on dark background, SVG vector activity bar icon.
- **Cleaner layout**: top toolbar removed; API key 🔑 moved to footer bottom-right.
- **Auto-grow textarea**: input box grows with content, GH Copilot style (max 200px).
- Stability fixes: activation crash from unescaped backtick in system prompt; JS null reference from removed DOM element.

### v0.28.3 — HTML Rendering · Account Balance

- **HTML rendering** in chat: model responses render full Markdown + HTML + KaTeX math.
- **Account balance** widget in footer: shows remaining DeepSeek credit, click to refresh.
- PR automation tooling improvements.

### v0.28.0 — MCP · Hooks · User Memory · Revert Last Turn

- **MCP client** (`src/mcp.js`): connect any MCP stdio tool server; tools appear as `mcp__<server>__<tool>`. Configure via `deepseekAgent.mcp.servers`.
- **Post-tool hooks** (`src/hooks.js`): run custom scripts after any tool call. Configure via `.deepcopilot/hooks.json`. Output injected into model context.
- **User memory**: `~/.deepcopilot/memory.md` is injected (capped 4 KB) into every system prompt as "User preferences".
- **Revert last turn**: `revert_last_turn` tool + `deepseekAgent.revertLastTurn` command — roll back all file changes from the current agent turn in one click.
- **Post-edit LSP diagnostics**: errors & warnings auto-appended after every file edit so the model can self-verify.

### v0.26.0 — Parallel tools · @file attach · apply_patch · Tool cache

- Multiple independent tool calls in one model turn (parallel execution). `@filename` attachment. `apply_patch` for multi-hunk edits. Tool result caching.

### v0.25.0 — Web search

- Added `web_search` tool powered by Tavily API.

### v0.24.2 — Flat tool UI

- Tool rows are now hairline-bordered, no fill, GitHub-Copilot-Chat style.

### v0.24.0 — Parallel sessions

- Switch sessions while a run is in flight; events buffer and replay on return. Refactored into modular `src/`.

### v0.20.0 — Copilot-grade UX overhaul

- Stop + Esc, blinking cursor, progress bar, code blocks with Run/Insert/Copy, syntax highlight, fold, hover bar, slash-commands, `@` refs, prompt history, bilingual error cards.

> Full history: see [git log](https://github.com/ZhouChaunge/DeepCopilot/commits/main) and [Releases](https://github.com/ZhouChaunge/DeepCopilot/releases).
</details>

---

## 📄 License

MIT © [ZhouChaunge](https://github.com/ZhouChaunge). See [LICENSE](./LICENSE).

---

## ⭐ Star History

<a href="https://www.star-history.com/#ZhouChaunge/DeepCopilot&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)"
            srcset="https://api.star-history.com/svg?repos=ZhouChaunge/DeepCopilot&type=Date&theme=dark&legend=top-left&_=20260518" />
    <source media="(prefers-color-scheme: light)"
            srcset="https://api.star-history.com/svg?repos=ZhouChaunge/DeepCopilot&type=Date&legend=top-left&_=20260518" />
    <img alt="Deep Copilot Star History"
         src="https://api.star-history.com/svg?repos=ZhouChaunge/DeepCopilot&type=Date&legend=top-left&_=20260518" />
  </picture>
</a>

---

<p align="center">
  <sub>Make high-quality AI productivity open, fair, and affordable for everyone.</sub>
</p>

<p align="center">
  <sub>This is a fork of <a href="https://github.com/ZhouChaunge/DeepCopilot">ZhouChaunge/DeepCopilot</a> — modded by <b>difr</b>.</sub>
</p>
