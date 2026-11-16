# Definition-driven Claude jobs

This route requires the Claude-enabled execution contract pinned by `package.json` and its lockfile. Use the normal locked install; no local dependency overlay is required. It does not change default Pi agents. Claude jobs require `runner: claude`; the former print/review transport is not supported.

Stage profiles outside discovery until separately approved. A trusted user/package definition has this shape:

```yaml
---
name: claude-coding
runner: claude
runner-version: 2.1.325
workspace-trust: existing
model: sonnet
thinking: low
auto-exit: true
interactive: false
native-tools: [Read, Glob, Grep, Edit, Write, Bash]
permission-mode: manual
native-allow: [Read, Glob, Grep, Edit, Write, Bash]
native-deny: [Agent]
---
Implement the assigned task and verify the result.
```

For a read-only follow-up, explicitly select another trusted profile with `native-tools: [Read, Glob, Grep]`, `permission-mode: dontAsk`, matching read grants and `native-deny: [Edit, Write, Bash, Agent]`. Resume with `subagent_resume` and the returned managed native session ID, not a Pi session path or arbitrary Claude UUID. Caller-owned records retain the UUID, task scope, actor and skill snapshots; the selected definition supplies the new instructions and permissions. `--system-prompt-snapshot off` ensures resumed instructions are rendered again.

These are unattended print jobs, not interactive permission sessions: `--permission-prompts none` makes any operation needing an unanswered approval fail closed instead of waiting for a nonexistent SDK permission host. It never grants permission or accepts a trust decision. The native interactive trust prerequisite remains a human action; a blocked coding operation requires an explicit policy decision rather than an automatic retry with broader grants.

Only Read, Glob, Grep, Edit, Write and Bash are supported built-in selections in this slice. Explicit permission rules may also deny Agent or grant tools on declared MCP servers (for example `mcp__tasks__todo`). MCP uses the existing host-bound contract: current Node/HOME, captured literal task store, stable actor and declared supported actions. The host rejects assignment-force flags and unknown task actions before launch; the installed consumer also fixes assignment-force authority off. CLI permissions are cooperative controls, not an OS/path sandbox. Bash grants permit arbitrary shell work unless narrowed by the trusted definition.

## Preflight and live checks

Trusted native definitions select the existing owned Core route without changing the default backend for Pi. A nonblank explicit mux override must select `herdr-core`; unsupported or classic overrides are rejected. Missing Core context fails without falling back to another backend or host.

The host verifies the actual `claude --version` against `runner-version`, resolves the executable without installation, and requires `hasTrustDialogAccepted: true` for the canonical cwd or its nearest verified Git repository root in the current HOME's `.claude.json`. Repository-root reuse follows the bounded repository trust lookup observed in the installed 2.1.325 embedded source (`bS`/`M2o`/`SS`), deliberately supporting less than its general ancestor lookup. The adapter walks canonical directories to the nearest `.git` marker and checks `/usr/bin/git rev-parse --show-toplevel` with Git environment overrides removed and global/system config disabled. A nested repository or worktree requires its own trust; malformed markers, unsupported discovery, symlink escapes and trust above that boundary do not inherit approval. Non-repository directories still require exact cwd trust. Git absence or discovery failure blocks inherited trust. Alternate `CLAUDE_CONFIG_DIR` and persisted-trust override environments fail closed both during preparation and in the actual Core terminal before exec. The launch-time guard execs the existing command without adding a supervisor or changing entry PID ownership. HOME is pinned in the actual argv. No trust entry is written and no permission prompt is accepted. Trust-file and executable-version checks remain prepare-time observations, not locks against same-user changes before launch.

Inspect readiness without starting login or updating software:

```sh
claude --version
claude auth status
```

A real coding/resume check additionally requires an already trusted disposable workspace, authorized account, working Core host, and the explicitly declared task MCP launcher/package. Use the normal `subagent` launch with the staged coding profile, wait for captured output and proven closure, then `subagent_resume` with the read-only profile. Verify fixture changes after coding and unchanged bytes after review. Missing trust or task installation remains a live-validation prerequisite, not permission to bypass or install it.

## Ambient controls and limits

The actual 2.1.325 help and embedded CLI source were inspected. `--safe-mode` cannot be used: its customization gate also blocks explicit MCP configuration. Instead the job sends empty `--setting-sources`, `--disable-slash-commands`, explicit `disableAllHooks`/`autoMemoryEnabled`/`disableClaudeAiConnectors` settings, strict explicit MCP configuration, and environment controls disabling automatic updates, nonessential traffic, CLAUDE.md discovery, automatic memory and Claude.ai connector MCP loading. The connector environment control is explicit even if managed settings override the flag settings.

Trusted host skill bodies are materialized in instructions; ambient slash skills are disabled. Managed/admin policy and built-in plugin behavior are not independently certified or removed. This is not a plugin, descendant-process, exclusive-memory or filesystem sandbox guarantee. Existing capture/known-entry/owned-Core closure evidence retains the same limits as Copilot jobs. No new lifecycle manager or streaming protocol is introduced.
