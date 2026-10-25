---
name: plan
description: >
  Plan rough ideas or concrete requests in the current conversation. Investigate
  source facts, clarify consequential choices, and draft one compact proposal
  with grounded tasks. No compulsory scout or planner pane.
---

# Plan

Stay in the current conversation for both rough ideas and concrete requests. Read the bundled `../../agents/planner.md` guidance, resolving that path relative to this skill's injected file location (`pi-extension/subagents/plan-skill.md`), never relative to the user project's current working directory, and follow its discovery, proposal, draft-task, fresh-review, and execution-consent contract as the main author. Do not spawn a planner just because `/plan` was invoked. A scout or researcher is optional when bounded investigation helps; investigate source-discoverable facts rather than asking the user.

Ask focused plain-English questions with recommendations only when unresolved goals or trade-offs could materially change the result. Otherwise investigate and draft directly. No mandatory phases, repeated continue gates, glossary ceremony, numerical risk forms, forced routine alternatives, or automatic grill skill loading. Explicit grilling remains opt-in.

Write `.pi/plans/YYYY-MM-DD-<name>/plan.md`. An ordinary proposal aims for 250–400 words explaining changed behavior/examples, unchanged scope, observable success checks, and consequential decisions. Never hide risks or commitments in optional worker detail to meet that aim. Cheap reversible internal choices stay agent-owned. Judge deliberation by undoing choices after shipping; hard-to-undo work needs evidence, recovery options or limits, meaningful alternatives, and explicit owner consent. Potential harm controls verification even when code rollback is cheap.

Draft independently implementable tasks with owned paths, constraints, code examples or exact source references, inline acceptance criteria, real tests, and integration sources of truth. Follow host/repository-declared task capability and tracker conventions before ticket operations; read `~/.pi/agent/skills/todo-tracker.md` when that managed path is configured. Do not assume every host has that file. If required task capability or conventions are unavailable, report the gap before ticket operations; do not invent a backend or silently proceed. Create tasks as `draft`, record IDs, then wire actual `Blocked by:` dependencies. Do not activate them while planning or reviewing.

Have a fresh read-only reviewer check the proposal and resolved task bodies for consistency and feasibility, using allowed source evidence without the author's conversation. Use standalone/lineage-only context, never `/iterate` or a full-context fork; do not claim filesystem isolation. Follow repository review-seat defaults. For authorized Pi-backed review, explicitly use `tools: "read"` and prohibit spawning; Claude Code read-only seats take no tool/fork overrides. Add a second independent technical check for hard-to-undo or high-harm work, at most two concurrent reviewers. Declare bounded time/run limits using existing host controls, not a new lifecycle manager.

In default main-conversation planning, the main author is the sole proposal/task writer and resolves findings. When deliberately delegated, the planner is the sole writer of its assigned proposal/draft tasks and resolves discovery and review findings; the orchestrator does not write them concurrently. Allow at most one fresh re-review of affected checks. Missing, empty, failed, or incomplete review preserves evidence and pauses promotion. Unresolved material blockers pause rather than becoming accepted at the retry limit. The main author/orchestrator presents the reviewed proposal and collects one explicit execution approval of that version. A deliberately delegated planner does not ask for permission to build or activate tasks; it returns reviewed artifacts, IDs, status, and evidence to the orchestrator for that single approval. Already verifiable execution approval for the identical reviewed version need not be re-asked; a summary, completion handshake, or approval of a direction alone is not proof. Only the main author/orchestrator activates fully wired tasks after successful review and that approval. Planning-only requests stop with drafts. Material proposal/task changes require renewed review and consent; routine internal choices do not. Reconcile artifacts, tickets, and VCS after restart; stale summaries are not permission.

When deliberately delegating planning, keep the planner interactive and provide explicit artifact paths, scope, constraints, evidence, and stop condition:

```typescript
subagent({ name: "Planner", agent: "planner", interactive: true, task: "Plan [goal]. Write .pi/plans/YYYY-MM-DD-<name>/plan.md and grounded draft tasks. [Resolved context, boundaries, references, checks]. Return reviewed artifacts, IDs, status, and evidence; do not ask for permission to build or activate tasks." })
```

The planner completes through `subagent_done`, not a manual close. Read its artifacts and reconcile draft tasks; its return is not execution approval.

After approval, the orchestrator verifies each task is unclaimed and eligible, including dependencies, then delegates without claiming on the worker's behalf. The implementation worker fetches and claims the task in the authoritative task scope before writes, following host/repository tracker conventions. A cross-workspace or scoped-store mismatch must pause before writes and be reported to the coordinator; do not steal a claim, force a transfer, or silently copy tickets. Supply resolved scope, constraints, examples, and acceptance checks, never only an opaque ID. Serialize writers in a shared checkout; concurrent work requires disjoint ownership. Retain real tests, polished commits, independent post-code review, and risk-appropriate contract validation, including non-mocked integration checks. Preserve failures and actual command output. Plan review cannot replace implementation verification.

Plans are ephemeral: durable constraints belong in self-contained ADRs, agent instructions, or code, not permanent references back to plans. Planning does not authorize host changes, repinning, live task migration, or altering active runs. `/iterate` remains a lightweight full-context fork. Use existing host lifecycle ownership; do not add pane/process/status machinery.
