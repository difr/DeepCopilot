# Deep Copilot (difred) v1.4.3

**Topic: readable tool rows, a build stamp, and no more stdin hangs**

> Patch release. One pass over how a tool call is drawn and reported, plus two bugs found while
> auditing it.

### 🧱 1. A tool row now reads like the call it made

The row used to repeat the program name — `node node --check …` — because the verb and the
command were printed side by side. The verb is the program detected from the command itself, so
the duplicate is dropped now, and quoted paths and script extensions (`node.exe`, `pnpm.cjs`)
are normalised along the way.

The target used to be cut at 80 characters in code and 120 in the title, which produced broken
half-sentences. Those cuts are gone: the row ellipsises at whatever width it has, the pane shows
the command in full, and a leading `cd … &&` is kept there because that pane is what a user
audits. Only the collapsed row drops it.

Every row opens now. The detail pane always carries the target on top, so a call whose result
never arrived — cancelled, or failed before dispatch — still opens to something. Rows with no
target stay inert until a result gives them a body.

Long commands are capped at `min(600px, 60%)` and ellipsised inside the blue chip rather than by
the parent, so the box ends where the cut happens. Tool names in a group summary share one chip
style, and the separator between them is a plain `&`.

### ⚙️ 2. The build is visible in Settings and in the log

The plugin footer shows `v1.4.3 · build <timestamp>`, and the first `ACTIVATE` line in the log
carries the same pair. The timestamp is the bundle's own mtime — the file esbuild rewrites on
every build — resolved through one shared helper, so both places cannot drift apart.

`npm run package` names the artefact from `package.json` in a Node script instead of a shell
expansion, which is why the previous release shipped a file called
`deep-copilot-difred-.npm_package_version.vsix` from CI.

### 🐚 3. A shell command can no longer wait on stdin forever

`cp.spawn` was called without `stdio`, so Node defaulted to a live pipe on stdin. Any command
that reads input — `findstr` without a file, `sort`, `more`, `cat` — waited forever for bytes
that never came, because nothing wrote to the pipe and nothing closed it. The timeout did not
help: it hands control back without killing the process.

`stdin` is `ignore` now, which is `NUL` on Windows and `/dev/null` elsewhere. Such commands get
EOF and finish immediately.

### ⚠️ Migrations

- `run_shell` no longer accepts stdin. A command that expects interactive input fails fast
  instead of hanging.
- The version line moved to the Settings footer; the header holds the title alone.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v142.md`
- Full list: `git log 773c195..HEAD --oneline`
