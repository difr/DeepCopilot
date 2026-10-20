# Deep Copilot (difred) v1.4.2

**Topic: inline code renders as its own box, and formulas inside backticks stay text**

> Patch release. Three fixes found while checking how formulas render after the KaTeX upgrade.

### 🧱 1. Inline code got its own box

`code.ic` was a plain inline element, so the browser collapsed the spaces around it in the
surrounding line: the grey background ran past the last character and touched the next word. It
is `inline-block` now, with `max-width:100%` and `overflow-wrap:anywhere`, so the box ends
exactly where the code ends and a long token wraps instead of spilling out of the message.

### 🏷️ 2. Tags and formulas inside backticks stay text

`renderMd` lifted whitelisted tags out of inline-code spans before escaping them, so a
`<span class="mfrac">` written between backticks landed in the DOM as a real element and
rendered as an empty box. It also restored the spans before math was parked, which pulled
`$x^2$` out of the code span and rendered it through KaTeX inside `code.ic`.

Both are fixed: the spans are parked before the HTML passthrough and restored after the math
pass, so anything between backticks stays text end to end.

Fenced blocks are parked ahead of everything for the same reason: the inline pass read their
triple backticks as a double-backtick span and swallowed the whole block into a one-line `code.ic`
with the newlines flattened. A closing marker now has to start a line and match the opening fence
in length, so a fence that appears mid-line — inside a regex, a string or a comment — no longer
ends the block early, and a four-backtick block can show three-backtick blocks inside.

A block written inside a quote loses the `>` markers from its body when the opening fence itself
is quoted, so quoted commands no longer show a prompt prefix that was never typed.

### 📦 3. Local scratch no longer ships

`tmp/` sat in the package and broke `vsce package` on the new secretlint step — one entry there
is a directory without an extension, so reading it as a file aborted with `EISDIR`. It is listed
in `.vscodeignore` now.

The same round strips the `sourceMappingURL` comment from the bundled DOMPurify: the `.map`
never ships, and the panel's CSP answered that request with `default-src 'none'` on every load.

### ⚠️ Migrations

- None. The chat and the stored histories behave exactly as before.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v141.md`
- Full list: `git log a572de5..HEAD --oneline`
