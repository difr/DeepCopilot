# Deep Copilot v0.32.7 — Release Notes

## 🇨🇳 中文说明

### 本次更新 (v0.32.6 → v0.32.7)

#### 新功能：多语言字体 + Webview 界面全面本地化（Issue #53）

**背景**

之前 Webview 始终使用 VS Code 编辑器字体（`var(--vscode-font-family)`），在中文环境下汉字通常以等宽字体渲染，观感偏窄；英文环境下无系统级 UI 字体优化。同时，界面所有文案均为硬编码中文，英文 VS Code 用户看到的是中文界面。

**改动内容**

**1. 自动字体切换**
- 启动时读取 `vscode.env.language`，检测 VS Code 显示语言。
- **中文环境**（`zh-*`）：字体栈优先使用 `Microsoft YaHei UI → Microsoft YaHei → PingFang SC → Hiragino Sans GB → Noto Sans CJK SC → Source Han Sans CN → WenQuanYi Micro Hei`，在 Windows / macOS / Linux 均有合理兜底。
- **其他语言**（`en` 等）：字体栈切换为 `Segoe UI → Inter → system-ui → -apple-system → BlinkMacSystemFont → Helvetica Neue → Arial`。
- 通过 `html[data-locale]` 属性实现 CSS 条件覆盖，无运行时开销。

**2. Webview 界面全面 i18n**
- 将 `src/webview/html.js` 中所有硬编码中文字符串（共 20 处）接入现有 `t()` 国际化系统。
- 涉及：欢迎页副标题、输入框 placeholder、侧边栏标签与按钮、会话列表空状态、思考中指示器、工具提示文本等。
- 中文 VS Code 保持原有中文界面；英文 VS Code 所有文案自动切换为英文。

**效果对比**

| 界面元素 | 中文 VSCode | 英文 VSCode |
|---------|------------|------------|
| 字体 | 微软雅黑 UI / 苹方 | Segoe UI / system-ui |
| 欢迎副标题 | 让高质量 AI 生产力开放、公平、普惠 | Open, fair, and accessible AI productivity for all |
| 输入框提示 | 描述要构建的内容 | Describe what you want to build |
| 会话面板 | 历史会话 / 本工作区 / 全部 | Sessions / Workspace / All |
| 思考指示 | ● ● ● 思考中... | ● ● ● Thinking... |

**受影响的文件**
- `src/webview/html.js` — 注入 `data-locale` 属性，接入 `t()` 翻译
- `src/utils/i18n.js` — 新增 20 条 `wv*` 前缀 Webview UI 字符串（中英两套）
- `media/chat.css` — 新增两条 `html[data-locale]` 条件字体规则

---

## 🇺🇸 English Release Notes

### What's Changed (v0.32.6 → v0.32.7)

#### New: Locale-aware fonts + full webview i18n (Issue #53)

**Background**

The webview previously used VS Code's editor font (`var(--vscode-font-family)`) for all UI text — a monospaced code font that renders poorly for Chinese characters. Additionally, every string in the webview HTML template was hardcoded in Chinese, making the interface unusable in non-Chinese locales.

**Changes**

**1. Automatic font switching**
- Reads `vscode.env.language` at startup to detect the active VS Code display language.
- **Chinese locale** (`zh-*`): font stack prioritises `Microsoft YaHei UI → Microsoft YaHei → PingFang SC → Hiragino Sans GB → Noto Sans CJK SC → Source Han Sans CN → WenQuanYi Micro Hei`, with full fallback coverage on Windows / macOS / Linux.
- **Other locales** (`en`, etc.): font stack switches to `Segoe UI → Inter → system-ui → -apple-system → BlinkMacSystemFont → Helvetica Neue → Arial`.
- Implemented via `html[data-locale]` CSS attribute selectors — zero runtime overhead, no bundled font files added.

**2. Full webview i18n**
- All 20 hardcoded Chinese strings in `src/webview/html.js` are now routed through the existing `t()` i18n system.
- Covers: welcome subtitle, input placeholder, session panel labels and buttons, empty-state text, thinking indicator, all button tooltips.
- Chinese VS Code users see the same Chinese interface as before; English VS Code users now see a fully English UI.

**Affected files**
- `src/webview/html.js` — injects `data-locale`, uses `t()` for all UI strings
- `src/utils/i18n.js` — adds 20 `wv*`-prefixed webview UI strings (EN + ZH)
- `media/chat.css` — adds two `html[data-locale]` conditional font-family rules
