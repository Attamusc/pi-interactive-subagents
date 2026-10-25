import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension, { __test__ as helpers } from "../pi-extension/subagents/index.ts";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";

// No provider, launcher process, historical session, or production todo store is used.
const proposal = "Proposal: add a local status label; no external requests.";
const tasks = "Resolved draft task: add status label. Hidden task-only commitment: send analytics externally.";
const brief = `Evidence-only plan check. ${proposal}\n${tasks}\nAllowed source: src/status.ts. Flag task-only commitments. Return findings inline; do not write or spawn.`;

// Source-policy assertions only: these do not establish model compliance.
test("both bundled planning sources require effective freshness and scope-safe worker briefs", () => {
  for (const path of ["../agents/planner.md", "../pi-extension/subagents/plan-skill.md"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    if (path === "../agents/planner.md") assert.match(source, /task: "Evidence-only plan check:/);
    for (const pattern of [/effective session mode/i, /fork: false.*does not override/is, /pause before dispatch/i, /do not resume an earlier reviewer/i, /scope-mismatch-before-writes rule in the worker brief/, /authoritative task scope before writes/, /mismatch must pause before writes/]) {
      assert.match(source, pattern, path);
    }
  }
});

test("bundled reviewer has a conditional pre-code evidence-only plan-check mode", () => {
  const role = readFileSync(new URL("../agents/reviewer.md", import.meta.url), "utf8");
  for (const pattern of [/evidence-only plan check/i, /clarity, self-containment, consistency/, /source contracts.*readiness/, /without requiring implemented code, a diff, or passing test output/, /return findings inline/i, /do not run commands, fetch todos, or write files/i, /missing or truncated.*incomplete/i, /steps below apply unless.*evidence-only review/i, /use the `write` tool to save the review/i, /tools: read, bash, write, todo/]) {
    assert.match(role, pattern);
  }
});

test("actual lineage seeding and SDK reconstruction exclude parent turns; fork negative control leaks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-context-"));
  try {
    const parentFile = join(dir, "parent.jsonl");
    const canary = "PARENT_CONVERSATION_CANARY_52eaf";
    const timestamp = new Date().toISOString();
    writeFileSync(parentFile, [
      { type: "session", version: 3, id: "parent", cwd: dir, timestamp },
      { type: "message", id: "first", parentId: null, timestamp, message: { role: "user", content: canary, timestamp: 1 } },
      { type: "message", id: "last", parentId: "first", timestamp, message: { role: "user", content: "latest request", timestamp: 2 } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
    for (const mode of ["lineage-only", "fork"] as const) {
      const childFile = join(dir, `${mode}.jsonl`);
      seedSubagentSessionFile({ mode, parentSessionFile: parentFile, childSessionFile: childFile, childCwd: dir });
      const child = SessionManager.open(childFile, dir);
      child.appendMessage({ role: "user", content: brief, timestamp: 3 });
      const observed = JSON.stringify(child.buildSessionContext().messages);
      assert.equal(observed.includes(canary), mode === "fork");
      assert.ok(observed.includes(proposal));
      assert.ok(observed.includes(tasks));
      assert.ok(observed.includes("Allowed source: src/status.ts"));
    }
    // Standard project instruction discovery remains available, not a filesystem sandbox.
    const project = join(dir, "project");
    const agentDir = join(dir, "agent");
    mkdirSync(project); mkdirSync(agentDir);
    writeFileSync(join(project, "AGENTS.md"), "ALLOWED_PROJECT_INSTRUCTION_19");
    const loader = new DefaultResourceLoader({ cwd: project, agentDir,
      settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true });
    await loader.reload();
    assert.ok(loader.getAgentsFiles().agentsFiles.some(file => file.path === join(project, "AGENTS.md") && file.content.includes("ALLOWED_PROJECT_INSTRUCTION_19")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real launch resolution and tool ceiling keep review fresh and read-only, with unsafe-seat controls", () => {
  const seats = [new URL("../agents/reviewer.md", import.meta.url)];
  for (const path of seats) {
    const source = readFileSync(path, "utf8").replace(/^model: .*$/m, "model: test/reviewer");
    const seat = helpers.parseVisibleAgentDefinition(path.pathname, source);
    const params = { name: "Plan check", agent: "reviewer", task: brief, tools: "read", interactive: false };
    assert.equal(helpers.resolveLaunchBehavior(params, seat).inheritsConversationContext, false);
    const intent = helpers.resolveVisibleLaunchIntent(params, seat, "/fixture");
    const tools = helpers.buildSubagentToolAllowlist(intent.effective.tools?.join(","))!.split(",");
    assert.deepEqual(tools, ["read", "caller_ping", "subagent_done"]);
    assert.equal(helpers.canSpawnDirectChildren(tools, helpers.resolveDenyTools(seat)), false);
    // Without the explicit override the generic code reviewer is NOT read-only.
    assert.ok(helpers.resolveVisibleLaunchIntent({ ...params, tools: undefined }, seat, "/fixture").effective.tools?.includes("write"));
  }
  const unsafe = helpers.parseVisibleAgentDefinition("/fixture/reviewer.md", "---\nname: reviewer\nsession-mode: fork\n---\nReviewer");
  assert.equal(helpers.resolveLaunchBehavior({ name: "check", task: brief, fork: false }, unsafe).inheritsConversationContext, true);
  // This negative control documents why instruction-level preflight must pause, not trust fork:false.
  assert.equal(helpers.canSpawnDirectChildren(null, new Set()), true);
});

test("native Claude command keeps its fixed tool restriction and starts fresh without resume", () => {
  const command = helpers.buildClaudeCommand({ resultFile: "/fixture/result", processIdFile: "/fixture/pid", runId: "review", task: brief });
  assert.match(command, /--tools 'Read,Glob,Grep'/);
  assert.match(command, /--allowedTools 'Read' 'Glob' 'Grep'/);
  assert.match(command, /--disallowedTools 'mcp__\*'/);
  assert.doesNotMatch(command, /--resume/);
  assert.ok(command.includes("Evidence-only plan check"));
  assert.ok(command.includes("Hidden task-only commitment"));
  const resumed = helpers.buildClaudeCommand({ resultFile: "/fixture/result", processIdFile: "/fixture/pid", runId: "review", task: brief, resumeSessionId: "old" });
  assert.match(resumed, /--resume/);
});

test("actual plan command injects candidate skill and support path; iterate remains full fork", async () => {
  const commands = new Map<string, any>();
  const messages: string[] = [];
  const notices: string[] = [];
  const api = { events: { on() { return () => {}; }, emit() {} }, on() {}, registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
    registerCommand(name: string, command: any) { commands.set(name, command); },
    sendUserMessage(message: string) { messages.push(message); }, getAllTools() { return []; } };
  extension(api as any);
  const previousMux = process.env.PI_SUBAGENT_MUX;
  const previousSocket = process.env.HERDR_SOCKET_PATH;
  process.env.PI_SUBAGENT_MUX = "herdr";
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const ctx = { ui: { notify(message: string) { notices.push(message); } } };
    await commands.get("plan").handler("  ", ctx);
    assert.equal(messages.length, 0);
    assert.equal(notices.length, 1);
    await commands.get("plan").handler("  add a label  ", ctx);
    const skill = readFileSync(new URL("../pi-extension/subagents/plan-skill.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes(skill));
    assert.match(messages[0], /location=".*\/pi-extension\/subagents\/plan-skill.md"/);
    assert.match(messages[0], /\.\.\/\.\.\/agents\/planner.md/);
    assert.ok(messages[0].endsWith("\n\nadd a label"));
    assert.equal(commands.has("bbq"), false);
    await commands.get("iterate").handler("adjust label", ctx);
    assert.match(messages[1], /fork: true/);
  } finally {
    if (previousMux === undefined) delete process.env.PI_SUBAGENT_MUX; else process.env.PI_SUBAGENT_MUX = previousMux;
    if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = previousSocket;
  }
});
