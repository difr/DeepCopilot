# Deep Copilot (difred) v1.3.1

**Topic: shell output is read as UTF-8, not as the console code page**

> Patch release. One fix, and it explains a whole class of "the tool showed garbage" reports.

### 🔤 1. `run_shell` no longer mangles Cyrillic

**Every chunk of shell output was decoded with the console code page.** On a Russian Windows
that is `cp866`, so a command that printed `привет мир` came back as `╨┐╤А╨╕╨▓╨╡╤В ╨╝╨╕╤А`
— UTF-8 bytes read as OEM. It affected everything modern: `node`, `git`, `findstr`, any tool
that writes UTF-8 regardless of the console.

**UTF-8 is tried first now.** Valid multi-byte text is almost certainly UTF-8, so it is passed
through untouched; the detected code page is used only when the bytes do not form valid UTF-8,
which is what `dir` and `type` produce. Encoding is now decided per chunk by its content instead
of per machine by the console.

**This also explains why `chcp 65001` did not help.** The code page was cached on the first
probe, so a `chcp` inside the command had no effect on the decoder. No cache change was needed
once the decision stopped depending on the console alone.

### 🔗 Related

- Upstream: Deep Copilot by ZhouChaunge — this fork is `difred` (`github.com/difr/DeepCopilot`)
- Previous release: `release/notes_v130.md`
- Full list: `git log 7419458..HEAD --oneline`
