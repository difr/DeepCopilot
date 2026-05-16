# Deep Copilot v0.32.6 — Release Notes

## 🇨🇳 中文说明

### 本次更新 (v0.32.5 → v0.32.6)

#### 修复：工具调用折叠不完整（Issue #51）

**问题背景**
之前 `run_shell`、`web_search`、`spawn_agent` 等卡片式工具从不参与折叠，只有轻量 prose 行（`read_file`、`list_dir` 等）才能被分组；并且折叠只对消息末尾的连续工具序列生效，中间段的工具序列会原样展开。

**修复内容**
- 新增 `getToolVerb()` 辅助函数，统一从 prose 行和卡片式工具中提取操作动词。
- 新增 `makeToolGroup()` 核心函数，支持将任意类型的工具元素批量包装为可折叠的 `.tl-group`。
- 新增 `groupAllToolRuns()`：在回复结束（`replyEnd`）时扫描整个 `.flow`，对**所有**连续工具序列（无论位于消息中部还是末尾）执行折叠，单个工具不受影响。
- 流式预折叠（`groupTrailingToolLines`）同样升级，现在可识别 `.tool` 卡片。

**效果**：多轮 Agent 执行后，每段连续工具调用均会折叠为 `Read ×3 · Ran · Searched ×2` 样式的可点击摘要行，点击可展开查看详情。

---

#### 修复：思考块臃肿、顶部固定、默认展开（Issue #52）

**问题背景**
DeepSeek R1 在每轮工具调用前都会输出 CoT 推理内容（`<think>` 标签）。原实现将所有轮次的推理内容追加到同一个顶部固定的文本块中，且默认展开，导致长任务时推理内容占据大量屏幕空间，实际回复内容被推到底部。

**修复内容**
- **默认折叠**：思考块现在默认折叠，用户可点击展开。
- **每轮独立**：新增 `makeThinkChip()` 函数，在每次 `newTurn`（Agent 进入新一轮迭代）时，在 `.flow` 中当前位置插入一个独立的内联思考芯片（`.think-slot`），而非继续追加到顶部块。
- **自动封闭**：`newTurn` 事件触发时，上一轮思考块自动标记为"Thought for Xs"并折叠。
- **精确状态追踪**：新增 `curThkHead` 状态变量，统一管理顶层思考头和内联芯片头，避免跨轮状态污染。
- 新增 `.think-slot` CSS，使内联芯片在 `.flow` 中正确布局。

**效果**：每轮 Agent 推理对应流程中的一个独立"Thinking… Xs"折叠芯片，结束后显示"Thought for Xs"，不再占用顶部固定位置，实际输出内容不被遮挡。

---

---

## 🇺🇸 English Release Notes

### What's Changed (v0.32.5 → v0.32.6)

#### Fix: Incomplete tool-call folding (Issue #51)

**Background**
Previously, card-type tools (`run_shell`, `web_search`, `spawn_agent`) were never included in the collapsible groups — only lightweight prose lines (`read_file`, `list_dir`, etc.) were. Additionally, folding only applied to the trailing run of tools at the end of a message; any mid-turn tool sequences remained fully expanded.

**Changes**
- Added `getToolVerb()` helper to extract the action verb uniformly from both prose-line tools and card-type tools.
- Added `makeToolGroup()` core function that wraps any array of contiguous tool elements into a collapsible `.tl-group`.
- Added `groupAllToolRuns()`: called at `replyEnd`, it scans the entire `.flow` and folds **every** contiguous tool run (mid-turn or trailing) into a summary row. Single-tool sequences are left ungrouped.
- The streaming look-ahead fold (`groupTrailingToolLines`) is also upgraded to recognise `.tool` cards.

**Result**: After a multi-step agent run, each contiguous block of tool calls collapses into a clickable `Read ×3 · Ran · Searched ×2` summary. Click to expand individual steps.

---

#### Fix: Monolithic, top-anchored, auto-expanded thinking block (Issue #52)

**Background**
DeepSeek R1 emits CoT reasoning (`<think>` tokens) before every tool-call iteration. The previous implementation appended all iterations' reasoning into a single block pinned to the top of the bubble, expanded by default. For long agentic tasks this flooded the screen with raw reasoning, pushing the actual reply far down.

**Changes**
- **Default-collapsed**: The thinking block is now collapsed by default. Users can click to expand any iteration's reasoning.
- **Per-iteration chips**: New `makeThinkChip()` function. On each `newTurn` event (a new agent iteration begins), an independent inline think chip (`.think-slot`) is appended at the current position inside `.flow`, rather than appending to the monolithic top block.
- **Auto-seal**: When `newTurn` fires, the previous iteration's thinking chip is automatically sealed with an elapsed-time label ("Thought for Xs") and collapsed.
- **Accurate state tracking**: New `curThkHead` variable tracks the active thinking head (either the original top-level head or an inline chip head), preventing cross-iteration state bleed.
- Added `.think-slot` CSS rule for correct inline layout.

**Result**: Each agent reasoning iteration appears as its own collapsible "Thinking… Xs" chip inline in the response flow. After completion it becomes "Thought for Xs". The main reply content is never obscured by a wall of reasoning text.
