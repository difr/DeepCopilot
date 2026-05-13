## Deep Copilot v0.30.13

### Install · 安装

Download **deep-copilot-0.30.13.vsix** from the Assets below, then:

```
code --install-extension deep-copilot-0.30.13.vsix --force
```

Or: VS Code Extensions panel → `⋯` → **Install from VSIX...**

---

## Highlights · 本次更新概览

**EN** v0.30.13 refactors the skill UI: the active `/skill` is now shown as a prominent blue pill inside the input row — always visible, never overlapping file attachment chips. A new `#skill-notice` DOM element is used instead of mixing the skill chip into the file-chip bar.

**中文** v0.30.13 重构了 Skill 提示 UI：激活的 `/skill` 现以醒目蓝色胶囊显示在输入行内（独立于文件附件 chip 区域），始终可见、永不遮盖。新增专用 `#skill-notice` DOM 元素，与文件 chip 栏彻底分离。

---

## What's New · 本版亮点

### 🔵 Skill Notice Bar · Skill 提示栏

**EN** When you select a `/skill` from the slash-command menu, a blue pill labelled `/<skill-name>` now appears **inside the input row** (to the left of the textarea), clearly showing which skill is staged. Click the `×` on the pill to deselect. File attachment chips (📄 file.ts) remain in the separate chip row above.

**中文** 从 `/` 菜单选中 Skill 后，输入行左侧会出现蓝色胶囊 `/<skill名>`，清晰标注当前挂载的 Skill。点击胶囊上的 `×` 即可取消。文件附件 chip（📄 file.ts）依旧显示在上方独立的 chip 栏中，互不干扰。

---

## Bug Fixes · 问题修复

| # | Fix |
|---|-----|
| 1 | Skill chip was rendered inside `#at-chips` alongside file chips → moved to dedicated `#skill-notice` element |
| 2 | `#inp` had `width:100%` preventing flex sibling layout → changed to `flex:1 1 auto; min-width:0` |
| 3 | Skill dismiss button was matched by the file-chip `click` handler → split into separate `skillNoticeEl` click listener |

---

## Files Changed · 改动文件

| File | Change |
|------|--------|
| `src/webview/html.js` | Added `#inp-row` wrapper; added `<div id="skill-notice">` |
| `media/chat.css` | Styles for `#inp-row`, `#skill-notice`, updated `#inp` flex properties |
| `media/chat.js` | New `renderSkillNotice()` fn; `renderChips()` no longer touches skill chip |
