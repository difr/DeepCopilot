# Deep Copilot (difred) v1.4.0

**Topic: confirmations in the chat, action bars, quoting a selection**

> Minor release. Three user-facing changes, all in the chat surface.

### 🛡️ 1. Dangerous commands are confirmed in the chat, not in a modal

A modal truncated a long command, so approving it meant agreeing to text the user could not
read. The card shows the whole command in a wrapping block and parks the turn until it is
answered. Dangerous commands offer three answers — **Allow once** (this run only), **Allow for
session** (until the window reloads) and **Deny**; write and exec approvals keep the two-button
card, because those were never cached. Stopping the turn replaces the buttons with `Cancelled`.

The result of `run_shell` says how a command was approved: `approval: once`, `approval: session`,
or no field at all when no question was asked. A refusal arrives as `Blocked`, an aborted turn as
`aborted by user`.

The pattern list grew, because a gate is only as good as its patterns: `rm -fr`, `rd /s /q`, a
bare `del *.*`, `git restore .`, `git checkout -- .`, `drop index`, `delete from` without a
where clause, `chmod -R 777`, `chown -R`, `docker system prune`, `docker rm -f`,
`git push --delete`. `git clean -fdxq` slipped through a trailing `\b` and no longer does.

### 🖱️ 2. Every message has an action bar

Each question and reply carries Copy, Regenerate (last reply only) and Edit (questions only),
with the time it was sent. "Latest" appears whenever the feed is scrolled away from the bottom,
not only while a turn runs.

Sub-agents stay read-only, and the tool list now says so: both `explore` and `general` receive
the read-only set, where before `general` was offered `write_file` and `run_shell` only to have
them refused at dispatch.

### 📎 3. Quote a selection into the composer

Right-clicking a selection inside the chat offers **Copy** and **Quote**. Quote appends a `>`
block below whatever is already typed, with the cursor on the next line. The native menu stays
in fields and on links, where "Copy link address" has no replacement.

### ⚠️ Migrations

- `run_shell` results may now carry an `approval` field. Nothing breaks if it is ignored.
- Questions and replies stored before this release show no timestamp at all; new ones do.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v131.md`
- Full list: `git log fbf9e5e..HEAD --oneline`
