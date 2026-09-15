import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createVisibleCompletionState, observeVisibleCompletion } from "../../pi-extension/subagents/completion-watch.ts";

const enabled = process.env.PI_TEST_DETERMINISTIC_HERDR_LIVE === "1";
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const exactPi = join(root, "node_modules", ".bin", "pi");
const sourceExtension = join(root, "pi-extension", "subagents", "index.ts");
const providerExtension = join(here, "deterministic-herdr-provider.ts");
const managedHerdr = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");

function herdr(args: string[]) {
  const output = execFileSync("herdr", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();
  if (!output) return {};
  try { return JSON.parse(output).result; }
  catch { return { read: { text: output } }; }
}
function lines(file: string): any[] {
  if (!existsSync(file)) return [];
  const body = readFileSync(file, "utf8");
  const lastNewline = body.lastIndexOf("\n");
  if (lastNewline < 0) return [];
  const complete = body.endsWith("\n") ? body.slice(0, -1) : body.slice(0, lastNewline);
  if (!complete) return [];
  return complete.split("\n").filter(Boolean).map(line => JSON.parse(line));
}
async function waitFor<T>(label: string, read: () => T | undefined, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function findOne(dir: string, suffix: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const matches: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (child.endsWith(suffix)) matches.push(child);
    }
  };
  visit(dir);
  return matches.length === 1 ? matches[0] : undefined;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
function workspaceIsGone(workspaceId: string): boolean {
  try { herdr(["workspace", "get", workspaceId]); return false; }
  catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    let response: { error?: { code?: string } };
    try { response = JSON.parse(stderr); } catch { throw error; }
    if (response.error?.code === "workspace_not_found") return true;
    throw error;
  }
}
function parentResults(sessionFile: string): any[] {
  return lines(sessionFile).filter(entry => entry.type === "custom_message" && entry.customType === "subagent_result");
}
function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  return message?.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") ?? "";
}
function childProviderRequests(events: string, name?: string): any[] {
  return lines(events).filter(event => event.event === "provider_invoked" && event.child === true && (!name || event.subagentName === name));
}

async function createMatrixFixture(scenario: string, extraConfig: Record<string, unknown> = {}) {
  const temp = mkdtempSync(join(tmpdir(), `pi-herdr-${scenario}-`));
  const agentDir = join(temp, "agent");
  const sessions = join(temp, "sessions");
  const events = join(temp, "events.jsonl");
  const gate = join(temp, "gate");
  const release = join(temp, "release");
  const versions = join(temp, "versions.jsonl");
  for (const dir of ["agents", "extensions", "packages", "models"]) mkdirSync(join(agentDir, dir), { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), "{\"packages\":[]}\n");
  writeFileSync(join(agentDir, "models.json"), "{\"providers\":{}}\n");
  writeFileSync(join(agentDir, "extensions", "deterministic-herdr-provider.ts"), readFileSync(providerExtension, "utf8"));
  writeFileSync(join(agentDir, "extensions", "deterministic-herdr-config.json"), `${JSON.stringify({ eventsFile: events, gateFile: gate, releaseFile: release, versionsFile: versions, scenario, ...extraConfig }, null, 2)}\n`);
  writeFileSync(join(agentDir, "agents", "deterministic-child.md"), `---\nname: deterministic-child\ndescription: matrix child\nmodel: deterministic-herdr/probe\ntools: subagent_done\nspawning: false\nauto-exit: false\ndisable-model-invocation: true\n---\nComplete deterministically.\n`);
  writeFileSync(join(agentDir, "agents", "deterministic-planner.md"), `---\nname: deterministic-planner\ndescription: interactive matrix planner\nmodel: deterministic-herdr/probe\ntools: planner_checkpoint,subagent_done\nspawning: false\nauto-exit: false\ninteractive: true\ndisable-model-invocation: true\n---\nDraft, wait for approval, then summarize and call subagent_done.\n`);
  writeFileSync(join(agentDir, "agents", "deterministic-missing-artifact.md"), `---\nname: deterministic-missing-artifact\ndescription: standalone artifact with unavailable skill\nmodel: deterministic-herdr/probe\ntools: subagent_done\nskills: missing-live-skill\nspawning: false\nauto-exit: true\nsession-mode: standalone\ndisable-model-invocation: true\n---\nFail closed before provider work.\n`);
  const created = herdr(["workspace", "create", "--cwd", temp, "--label", `TEST ${scenario} ${Date.now()}`, "--env", "PATH=/opt/homebrew/bin:/usr/bin:/bin", "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SUBAGENT_MUX=herdr", "--no-focus"]);
  const workspaceId = created.workspace.workspace_id;
  const rootPane = created.root_pane.pane_id;
  const command = [
    "env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_FILE -u PI_SUBAGENT_ACTIVITY_FILE -u PI_SUBAGENT_NAME -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_SURFACE",
    `${JSON.stringify(exactPi)} -ne`, `-e ${JSON.stringify(sourceExtension)}`, `-e ${JSON.stringify(managedHerdr)}`, `-e ${JSON.stringify(providerExtension)}`,
    "--offline --provider deterministic-herdr --model probe", `--session-dir ${JSON.stringify(sessions)}`,
    "--no-builtin-tools --tools subagent --no-skills --no-prompt-templates --no-context-files --no-themes",
    JSON.stringify(`Run deterministic ${scenario} fixture.`),
  ].join(" ");
  herdr(["pane", "run", rootPane, command]);
  return { temp, agentDir, sessions, events, gate, release, versions, workspaceId, rootPane }; 
}

async function cleanupMatrixFixture(fixture: Awaited<ReturnType<typeof createMatrixFixture>>, pids: number[]) {
  for (const pid of pids.filter(pid => pid !== pids[0])) await waitFor(`matrix child PID ${pid} cleanup`, () => !alive(pid) ? true : undefined, 10_000);
  await waitFor("matrix child pane cleanup", () => {
    const panes = herdr(["pane", "list", "--workspace", fixture.workspaceId]).panes ?? [];
    return panes.length === 1 && panes[0].pane_id === fixture.rootPane ? true : undefined;
  }, 10_000);
  herdr(["workspace", "close", fixture.workspaceId]);
  await waitFor("matrix workspace cleanup", () => workspaceIsGone(fixture.workspaceId) ? true : undefined, 10_000);
  for (const pid of pids) await waitFor(`matrix PID ${pid} cleanup`, () => !alive(pid) ? true : undefined, 10_000);
  rmSync(fixture.temp, { recursive: true, force: true });
}

it("delivers one real Herdr child result only after done settles and Pi exits", { skip: !enabled, timeout: 120_000 }, async (t) => {
  assert.equal(process.env.HERDR_ENV, "1", "live test must run inside Herdr");
  assert.equal(execFileSync(exactPi, ["--version"], { encoding: "utf8" }).trim(), "0.85.1");
  assert.match(execFileSync("herdr", ["integration", "status"], { encoding: "utf8" }), /^pi: current \(v8\)/m);

  const temp = mkdtempSync(join(tmpdir(), "pi-herdr-deterministic-"));
  const agentDir = join(temp, "agent");
  const sessions = join(temp, "sessions");
  const events = join(temp, "events.jsonl");
  const gate = join(temp, "gate");
  const release = join(temp, "release");
  const versions = join(temp, "versions.jsonl");
  const evidenceBase = process.env.PI_TEST_EVIDENCE_DIR ?? tmpdir();
  mkdirSync(evidenceBase, { recursive: true });
  const forensicDir = mkdtempSync(join(evidenceBase, "pi-herdr-live-evidence-"));
  t.diagnostic(`Herdr live evidence: ${forensicDir}`);
  let workspaceId: string | undefined;
  let rootPane: string | undefined;
  let childPid: number | undefined;
  let parentPid: number | undefined;
  let parentSessionFile: string | undefined;
  let completed = false;
  try {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(agentDir, "packages"), { recursive: true });
    mkdirSync(join(agentDir, "models"), { recursive: true });
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{\"packages\":[]}\n");
    writeFileSync(join(agentDir, "models.json"), "{\"providers\":{}}\n");
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-provider.ts"), readFileSync(providerExtension, "utf8"));
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-config.json"), `${JSON.stringify({ eventsFile: events, gateFile: gate, releaseFile: release, versionsFile: versions }, null, 2)}\n`);
    writeFileSync(join(agentDir, "agents", "deterministic-child.md"), `---\nname: deterministic-child\ndescription: deterministic live-test child\nmodel: deterministic-herdr/probe\ntools: subagent_done\nspawning: false\nauto-exit: false\ndisable-model-invocation: true\n---\nCall subagent_done exactly once.\n`);
    const created = herdr(["workspace", "create", "--cwd", temp, "--label", `TEST deterministic-completion ${Date.now()}`, "--env", "PATH=/opt/homebrew/bin:/usr/bin:/bin", "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SUBAGENT_MUX=herdr", "--no-focus"]);
    workspaceId = created.workspace.workspace_id;
    rootPane = created.root_pane.pane_id;

    const command = [
      "env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_FILE -u PI_SUBAGENT_ACTIVITY_FILE -u PI_SUBAGENT_NAME -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_SURFACE",
      `${JSON.stringify(exactPi)} -ne`, `-e ${JSON.stringify(sourceExtension)}`, `-e ${JSON.stringify(managedHerdr)}`, `-e ${JSON.stringify(providerExtension)}`,
      "--offline --provider deterministic-herdr --model probe", `--session-dir ${JSON.stringify(sessions)}`,
      "--no-builtin-tools --tools subagent --no-skills --no-prompt-templates --no-context-files --no-themes",
      JSON.stringify("Launch the deterministic child exactly once and wait for its result."),
    ].join(" ");
    herdr(["pane", "run", rootPane, command]);

    try {
      await waitFor("child done gate", () => existsSync(gate) ? true : undefined, 30_000);
    } catch (error) {
      const screen = herdr(["pane", "read", rootPane, "--source", "recent-unwrapped", "--lines", "200"]);
      const panes = herdr(["pane", "list", "--workspace", workspaceId!]).panes ?? [];
      const paneScreens = panes.map((pane: any) => {
        const paneId = pane.pane_id;
        const read = herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "200"]);
        return `${paneId}:\n${read.read?.text ?? JSON.stringify(read)}`;
      }).join("\n");
      throw new Error(`${error instanceof Error ? error.message : error}\nEvents:\n${readFileSync(events, "utf8")}\nPanes:\n${paneScreens}\nParent pane:\n${screen.read?.text ?? JSON.stringify(screen)}`);
    }
    const observedEvents = lines(events);
    const parentStart = observedEvents.find(event => event.event === "session_start" && event.subagentId === null);
    const gateEvent = observedEvents.find(event => event.event === "child_done_tool_result_gate");
    assert.ok(parentStart?.sessionFile, "parent must record its public session file");
    parentPid = parentStart.pid;
    parentSessionFile = parentStart.sessionFile;
    assert.ok(gateEvent, "real child subagent_done must reach tool_result");
    childPid = gateEvent.pid;
    assert.equal(gateEvent.processAlive, true);
    assert.equal(alive(childPid!), true);
    assert.equal(gateEvent.snapshot.version, 1);
    assert.match(gateEvent.snapshot.sourceId, /^pi-child:/);
    assert.equal(gateEvent.snapshot.sessionFile.endsWith(".jsonl"), true);
    assert.equal(gateEvent.snapshot.latestFacts.some((fact: any) => fact.kind === "completion-requested" && fact.reason === "done"), true);
    assert.equal(gateEvent.snapshot.latestFacts.some((fact: any) => fact.kind === "agent-settled"), false);

    const childSnapshot = findOne(sessions, ".child.json") ?? await waitFor("child snapshot path", () => findOne(sessions, ".child.json"));
    const wrapper = childSnapshot.replace(/\.child\.json$/, ".wrapper.json");
    assert.equal(existsSync(wrapper), false, "wrapper must not report exit at the done tool-result gate");
    assert.equal(parentResults(parentSessionFile).length, 0, "parent session must contain no result at the gate");
    const state = createVisibleCompletionState(gateEvent.snapshot.runId);
    const status = observeVisibleCompletion({ state, childSnapshotFile: childSnapshot, wrapperExitFile: wrapper });
    assert.deepEqual({ status: status.status, terminal: status.terminal }, { status: "finishing", terminal: false });
    assert.equal(herdr(["pane", "get", rootPane]).pane.agent_status, "blocked");

    writeFileSync(release, "release\n");
    await waitFor("one parent delivery", () => parentResults(parentSessionFile!).length === 1 ? true : undefined);
    await waitFor("wrapper exit", () => existsSync(wrapper) ? true : undefined);
    await waitFor("child process exit", () => !alive(childPid!) ? true : undefined);

    const finalSnapshot = JSON.parse(readFileSync(childSnapshot, "utf8"));
    const wrapperRecord = JSON.parse(readFileSync(wrapper, "utf8"));
    const facts = finalSnapshot.latestFacts;
    const requested = facts.find((fact: any) => fact.kind === "completion-requested");
    const settled = facts.find((fact: any) => fact.kind === "agent-settled");
    const shutdown = facts.find((fact: any) => fact.kind === "session-shutdown");
    assert.ok(requested.sequence < settled.sequence && settled.sequence < shutdown.sequence);
    assert.equal(finalSnapshot.version, 1);
    assert.equal(finalSnapshot.sourceId, `pi-child:${finalSnapshot.runId}`);
    assert.equal(wrapperRecord.version, 1);
    assert.equal(wrapperRecord.sourceId, `wrapper:${finalSnapshot.runId}`);
    assert.equal(wrapperRecord.exit.shellStatus, 0);
    assert.ok(Date.parse(wrapperRecord.observedAt) >= Date.parse(shutdown.observedAt));
    const delivered = parentResults(parentSessionFile);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].details.name, "DeterministicChild");
    assert.equal(delivered[0].details.sessionFile, finalSnapshot.sessionFile);
    assert.equal(delivered[0].details.exitCode, 0);
    assert.match(delivered[0].content, /CHILD_COMPLETION_SUMMARY/);
    assert.doesNotMatch(delivered[0].content, /CHILD_POST_TOOL_STOP/);
    const childProviderInvocations = childProviderRequests(events);
    assert.equal(childProviderInvocations.length, 1, "subagent_done must not trigger a trailing provider request");
    const initialUserMessages = childProviderInvocations[0].requestMessages.filter((message: any) => message.role === "user");
    assert.equal(initialUserMessages.length, 1, "child bootstrap and task must be one initial user prompt");
    const initialInput = messageText(initialUserMessages[0]);
    assert.match(initialInput, /Call subagent_done exactly once\./);
    assert.doesNotMatch(initialInput, /<skill name=/, "zero-skill launch must not synthesize a skill block");
    assert.ok(existsSync(finalSnapshot.sessionFile));
    assert.equal(lines(finalSnapshot.sessionFile)[0].type, "session");

    const versionRows = await waitFor("parent and child versions", () => lines(versions).length >= 2 ? lines(versions) : undefined);
    assert.equal(versionRows.every((row: any) => row.version === "0.85.1"), true);
    assert.equal(versionRows.every((row: any) => row.execPath.startsWith("/") && row.entrypoint.startsWith("/") && !row.entrypoint.endsWith("deterministic-herdr-provider.ts")), true);
    assert.equal(versionRows.some((row: any) => row.subagentId === null && row.entrypoint === exactPi), true);
    assert.equal(versionRows.some((row: any) => row.subagentId === finalSnapshot.runId), true);
    await waitFor("registration and blocked state clear", () => {
      const panes = herdr(["pane", "list", "--workspace", workspaceId!]).panes;
      const statusNow = herdr(["pane", "get", rootPane!]).pane.agent_status;
      return panes.length === 1 && statusNow !== "blocked" ? true : undefined;
    });
    assert.equal(parentResults(parentSessionFile).length, 1, "cleanup must not duplicate delivery");
    completed = true;
  } finally {
    const evidenceRun = join(forensicDir, "run");
    if (existsSync(temp)) cpSync(temp, evidenceRun, { recursive: true });
    writeFileSync(join(forensicDir, "result.json"), `${JSON.stringify({ completed, recordedAt: new Date().toISOString(), workspaceId, rootPane, parentPid, childPid, workingTemp: temp }, null, 2)}\n`);
    if (workspaceId) {
      herdr(["workspace", "close", workspaceId]);
      await waitFor("owned workspace cleanup", () => workspaceIsGone(workspaceId!) ? true : undefined, 10_000);
    }
    if (parentPid) await waitFor("owned parent PID exit", () => !alive(parentPid!) ? true : undefined, 10_000);
    if (childPid) await waitFor("owned child PID exit", () => !alive(childPid!) ? true : undefined, 10_000);
    writeFileSync(join(forensicDir, "cleanup.json"), `${JSON.stringify({ workspaceGone: workspaceId ? workspaceIsGone(workspaceId) : true, parentGone: parentPid ? !alive(parentPid) : null, childGone: childPid ? !alive(childPid) : null }, null, 2)}\n`);
    rmSync(temp, { recursive: true, force: true });
  }
});

it("fails closed for missing skills in direct-fork and standalone artifact launches", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const variants = [
    { label: "direct-fork", config: { childName: "MissingDirectSkillChild" } },
    { label: "artifact-standalone", config: { childName: "MissingArtifactSkillChild", missingSkillAgent: "deterministic-missing-artifact" } },
  ];
  for (const variant of variants) {
    const fixture = await createMatrixFixture("missing-skill", variant.config);
    const forensicDir = mkdtempSync(join(process.env.PI_TEST_EVIDENCE_DIR ?? tmpdir(), `pi-herdr-missing-skill-${variant.label}-evidence-`));
    t.diagnostic(`Herdr missing-skill ${variant.label} evidence: ${forensicDir}`);
    const pids: number[] = [];
    try {
      const childStart = await waitFor(`${variant.label} child start`, () => lines(fixture.events).find(event => event.event === "session_start" && event.subagentId !== null), 30_000);
      const parentStart = lines(fixture.events).find(event => event.event === "session_start" && event.subagentId === null);
      pids.push(parentStart.pid, childStart.pid);
      const result = await waitFor(`${variant.label} parent result`, () => parentResults(parentStart.sessionFile)[0]);
      assert.match(result.content, /missing-live-skill/);
      assert.match(result.content, /not found|unavailable/i);
      assert.equal(result.details.exitCode, 1, "bootstrap rejection must remain a failed disposition");
      assert.equal(childProviderRequests(fixture.events).length, 0, "missing skills must fail before child provider work");
      const snapshotPath = await waitFor(`${variant.label} sidecar`, () => findOne(fixture.sessions, `${childStart.subagentId}.child.json`));
      const wrapperPath = snapshotPath.replace(/\.child\.json$/, ".wrapper.json");
      await waitFor(`${variant.label} wrapper`, () => existsSync(wrapperPath) ? true : undefined);
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
      const wrapper = JSON.parse(readFileSync(wrapperPath, "utf8"));
      assert.equal(snapshot.runId, childStart.subagentId);
      assert.equal(wrapper.runId, childStart.subagentId);
      assert.equal(wrapper.exit.shellStatus, 0, "structured failure shuts the child shell down gracefully");
      assert.equal(snapshot.latestFacts.some((fact: any) => fact.kind === "completion-requested" && fact.reason === "agent-error"), true);
      if (variant.label === "artifact-standalone") {
        assert.equal(childStart.agent, "deterministic-missing-artifact", "artifact variant must resolve the agent definition");
        const launchCall = lines(fixture.events).find(event => event.event === "provider_emitted_tool_call" && event.child === false);
        assert.equal(launchCall.toolName, "subagent");
        assert.equal(launchCall.toolCallId, "spawn-missing");
        assert.equal(launchCall.toolCallArguments.agent, "deterministic-missing-artifact");
        assert.equal(launchCall.toolCallArguments.skills, undefined);
        assert.equal(launchCall.toolCallArguments.fork, undefined);
      }
      await waitFor(`${variant.label} child exit`, () => !alive(childStart.pid) ? true : undefined);
      cpSync(fixture.temp, join(forensicDir, "run"), { recursive: true });
    } finally {
      await cleanupMatrixFixture(fixture, pids);
      writeFileSync(join(forensicDir, "cleanup.json"), `${JSON.stringify({ pidsGone: pids.every(pid => !alive(pid)), workspaceGone: workspaceIsGone(fixture.workspaceId) }, null, 2)}\n`);
    }
  }
});

it("bounds live oversized and control-bearing tool call observations without changing raw IDs", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const vectors = [
    { label: "long", raw: "x".repeat(512), digest: "sha256:64164443bb63e338ef1cfdb12a57117cd1212270cc935a798f6e8a665cdf4659" },
    { label: "control", raw: "provider\nexpanded", digest: "sha256:ec443626959aa8ee6bbdcb4a473fadb0affae73f00798907558c564dea6b9460" },
  ];
  for (const vector of vectors) {
    const fixture = await createMatrixFixture(`tool-id-${vector.label}`, { scenario: "completion", childName: `ToolId${vector.label}`, fixtureToolCallId: vector.raw });
    const forensicDir = mkdtempSync(join(process.env.PI_TEST_EVIDENCE_DIR ?? tmpdir(), `pi-herdr-tool-id-${vector.label}-evidence-`));
    t.diagnostic(`Herdr ${vector.label} tool-id evidence: ${forensicDir}`);
    const pids: number[] = [];
    try {
      await waitFor(`${vector.label} done gate`, () => existsSync(fixture.gate) ? true : undefined, 30_000);
      const starts = lines(fixture.events).filter(event => event.event === "session_start");
      pids.push(...starts.map(event => event.pid));
      const childStart = starts.find(event => event.subagentId !== null);
      const execution = lines(fixture.events).find(event => event.event === "tool_execution_start" && event.subagentId === childStart.subagentId);
      assert.equal(execution.rawToolCallId, vector.raw);
      assert.equal(execution.activity.toolCallId, vector.digest);
      assert.ok(execution.activity.toolCallId.length < 80);
      const emitted = lines(fixture.events).find(event => event.event === "provider_emitted_tool_call" && event.child === true);
      assert.equal(emitted.toolCallId, vector.raw, "provider seam must retain the original opaque ID");
      assert.equal(lines(childStart.sessionFile).some(entry => entry.message?.content?.some?.((part: any) => part.type === "toolCall" && part.id === vector.raw)), true, "transcript must retain the original opaque ID");
      assert.equal(lines(fixture.events).some(event => /stalled|recovered/.test(event.event)), false);
      writeFileSync(fixture.release, "release\n");
      await waitFor(`${vector.label} child exit`, () => !alive(childStart.pid) ? true : undefined);
      const parentStart = starts.find(event => event.subagentId === null);
      await waitFor(`${vector.label} parent result`, () => parentResults(parentStart.sessionFile).length === 1 ? true : undefined);
      assert.equal(childProviderRequests(fixture.events).length, 1, "completion tool must not cause a trailing request");
      cpSync(fixture.temp, join(forensicDir, "run"), { recursive: true });
    } finally {
      await cleanupMatrixFixture(fixture, pids);
      writeFileSync(join(forensicDir, "cleanup.json"), `${JSON.stringify({ pidsGone: pids.every(pid => !alive(pid)), workspaceGone: workspaceIsGone(fixture.workspaceId) }, null, 2)}\n`);
    }
  }
});

it("keeps a planner interactive until approval then returns its final summary through done", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const fixture = await createMatrixFixture("planner", { childName: "PlannerFixture" });
  const forensicDir = mkdtempSync(join(process.env.PI_TEST_EVIDENCE_DIR ?? tmpdir(), "pi-herdr-planner-evidence-"));
  t.diagnostic(`Herdr planner evidence: ${forensicDir}`);
  const pids: number[] = [];
  try {
    const draft = await waitFor("planner draft settlement", () => lines(fixture.events).find(event => event.event === "agent_settled" && event.subagentName === "PlannerFixture"), 30_000);
    const starts = lines(fixture.events).filter(event => event.event === "session_start");
    pids.push(...starts.map(event => event.pid));
    const parentStart = starts.find(event => event.subagentId === null);
    const plannerStart = starts.find(event => event.subagentName === "PlannerFixture");
    assert.equal(alive(plannerStart.pid), true, "interactive planner must remain open after its draft settles");
    assert.equal(parentResults(parentStart.sessionFile).length, 0);
    assert.equal(draft.snapshot.latestFacts.some((fact: any) => fact.kind === "completion-requested"), false);
    const childPane = await waitFor("planner pane", () => (herdr(["pane", "list", "--workspace", fixture.workspaceId]).panes ?? []).find((pane: any) => pane.pane_id !== fixture.rootPane));
    herdr(["pane", "send-text", childPane.pane_id, "fixture approve plan"]);
    herdr(["pane", "send-keys", childPane.pane_id, "enter"]);
    await waitFor("planner done gate", () => existsSync(fixture.gate) ? true : undefined);
    const requests = childProviderRequests(fixture.events, "PlannerFixture");
    assert.equal(requests.length, 3, "planner gets its draft, approval summary, and tool-only done turn");
    assert.equal(messageText(requests[1].requestMessages.at(-1)), "fixture approve plan");
    const emittedDone = lines(fixture.events).find(event => event.event === "provider_emitted_tool_call" && event.subagentName === "PlannerFixture" && event.toolName === "subagent_done");
    assert.ok(emittedDone);
    writeFileSync(fixture.release, "release\n");
    const result = await waitFor("planner parent summary", () => parentResults(parentStart.sessionFile)[0]);
    assert.match(result.content, /PLANNER_FINAL_SUMMARY/);
    assert.doesNotMatch(result.content, /PLANNER_DRAFT_WAITING_FOR_APPROVAL/);
    await waitFor("planner exit", () => !alive(plannerStart.pid) ? true : undefined);
    assert.equal(childProviderRequests(fixture.events, "PlannerFixture").length, 3, "done must not trigger a trailing planner request");
    cpSync(fixture.temp, join(forensicDir, "run"), { recursive: true });
  } finally {
    await cleanupMatrixFixture(fixture, pids);
    writeFileSync(join(forensicDir, "cleanup.json"), `${JSON.stringify({ pidsGone: pids.every(pid => !alive(pid)), workspaceGone: workspaceIsGone(fixture.workspaceId) }, null, 2)}\n`);
  }
});

it("interrupts then terminates one real held Herdr child through registered tools", { skip: !enabled, timeout: 120_000 }, async (t) => {
  assert.equal(process.env.HERDR_ENV, "1", "live test must run inside Herdr");
  assert.equal(execFileSync(exactPi, ["--version"], { encoding: "utf8" }).trim(), "0.85.1");

  const temp = mkdtempSync(join(tmpdir(), "pi-herdr-control-"));
  const agentDir = join(temp, "agent");
  const sessions = join(temp, "sessions");
  const events = join(temp, "events.jsonl");
  const versions = join(temp, "versions.jsonl");
  const evidenceBase = process.env.PI_TEST_EVIDENCE_DIR ?? tmpdir();
  mkdirSync(evidenceBase, { recursive: true });
  const forensicDir = mkdtempSync(join(evidenceBase, "pi-herdr-control-evidence-"));
  t.diagnostic(`Herdr control evidence: ${forensicDir}`);
  let workspaceId: string | undefined;
  let rootPane: string | undefined;
  let childPid: number | undefined;
  let parentPid: number | undefined;
  let parentSessionFile: string | undefined;
  let completed = false;
  try {
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(agentDir, "packages"), { recursive: true });
    mkdirSync(join(agentDir, "models"), { recursive: true });
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), "{\"packages\":[]}\n");
    writeFileSync(join(agentDir, "models.json"), "{\"providers\":{}}\n");
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-provider.ts"), readFileSync(providerExtension, "utf8"));
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-config.json"), `${JSON.stringify({ eventsFile: events, gateFile: join(temp, "unused-gate"), releaseFile: join(temp, "unused-release"), versionsFile: versions, scenario: "control", childName: "ControlledChild" }, null, 2)}\n`);
    writeFileSync(join(agentDir, "agents", "deterministic-child.md"), `---\nname: deterministic-child\ndescription: deterministic held child\nmodel: deterministic-herdr/probe\ntools: none\nspawning: false\nauto-exit: false\ndisable-model-invocation: true\n---\nWait for control.\n`);
    const created = herdr(["workspace", "create", "--cwd", temp, "--label", `TEST deterministic-control ${Date.now()}`, "--env", "PATH=/opt/homebrew/bin:/usr/bin:/bin", "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SUBAGENT_MUX=herdr", "--no-focus"]);
    workspaceId = created.workspace.workspace_id;
    rootPane = created.root_pane.pane_id;

    const command = [
      "env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_FILE -u PI_SUBAGENT_ACTIVITY_FILE -u PI_SUBAGENT_NAME -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_SURFACE",
      `${JSON.stringify(exactPi)} -ne`, `-e ${JSON.stringify(sourceExtension)}`, `-e ${JSON.stringify(managedHerdr)}`, `-e ${JSON.stringify(providerExtension)}`,
      "--offline --provider deterministic-herdr --model probe", `--session-dir ${JSON.stringify(sessions)}`,
      "--no-builtin-tools --tools subagent,subagent_interrupt,subagent_terminate --no-skills --no-prompt-templates --no-context-files --no-themes",
      JSON.stringify("Launch the controlled child and wait."),
    ].join(" ");
    herdr(["pane", "run", rootPane, command]);

    const held = await waitFor("held child stream", () => lines(events).find(event => event.event === "child_stream_held"), 30_000);
    childPid = held.pid;
    const starts = lines(events).filter(event => event.event === "session_start");
    const parentStart = starts.find(event => event.subagentId === null);
    const childStart = starts.find(event => event.subagentId !== null);
    assert.ok(parentStart?.sessionFile && childStart?.sessionFile);
    parentPid = parentStart.pid;
    parentSessionFile = parentStart.sessionFile;
    assert.equal(alive(childPid), true);
    const childPane = await waitFor("child pane", () => {
      const panes = herdr(["pane", "list", "--workspace", workspaceId!]).panes;
      return panes.length === 2 ? panes.find((pane: any) => pane.pane_id !== rootPane) : undefined;
    });
    assert.ok(childPane.pane_id, "real child session must own a Herdr pane");
    assert.equal(herdr(["pane", "get", rootPane]).pane.agent_status, "blocked");

    herdr(["pane", "send-text", rootPane, "fixture interrupt"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    await waitFor("real child abort signal", () => lines(events).find(event => event.event === "child_stream_aborted"));
    const interruptedSettled = await waitFor("child agent settled", () => lines(events).find(event => event.event === "agent_settled" && event.subagentId !== null));
    assert.equal(alive(childPid), true, "interrupt must leave the child process alive");
    const panesAfterInterrupt = herdr(["pane", "list", "--workspace", workspaceId]).panes;
    assert.equal(panesAfterInterrupt.some((pane: any) => pane.pane_id === childPane.pane_id), true, "interrupt must preserve the child session pane");
    assert.equal(interruptedSettled.snapshot.latestFacts.some((fact: any) => fact.kind === "completion-requested"), false, "interrupt must not request completion");
    const childSnapshot = await waitFor("interrupt child snapshot", () => findOne(sessions, ".child.json"));
    assert.equal(existsSync(childSnapshot.replace(/\.child\.json$/, ".wrapper.json")), false, "interrupt must not produce wrapper exit");
    assert.equal(parentResults(parentSessionFile).length, 0);
    const interruptReceipt = lines(parentSessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent_interrupt");
    assert.equal(interruptReceipt?.message.details?.name, "ControlledChild");
    assert.equal(interruptReceipt?.message.details?.status, "interrupt_requested");
    assert.equal(herdr(["pane", "get", rootPane]).pane.agent_status, "blocked");

    herdr(["pane", "send-text", rootPane, "fixture terminate"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    await waitFor("child process exit", () => !alive(childPid!) ? true : undefined);
    await waitFor("one final parent result", () => parentResults(parentSessionFile!).length === 1 ? true : undefined);
    const delivered = parentResults(parentSessionFile);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].details.name, "ControlledChild");
    assert.notEqual(delivered[0].details.exitCode, 0);
    assert.equal(delivered[0].details.error, "terminated");
    assert.match(delivered[0].content, /terminated by parent request/i);
    assert.doesNotMatch(delivered[0].content, /provider\/agent error|auto-retry exhausted/i);
    const terminateReceipt = lines(parentSessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent_terminate");
    assert.equal(terminateReceipt?.message.details?.name, "ControlledChild");
    assert.ok(["termination_requested_unconfirmed", "terminated"].includes(terminateReceipt?.message.details?.status));
    assert.equal(alive(childPid), false, "result must be observed after process exit");
    assert.equal(lines(parentSessionFile).some(entry => entry.type === "custom_message" && entry.customType === "subagent_result"), true);
    await waitFor("child pane removal and parent unblock", () => {
      const panes = herdr(["pane", "list", "--workspace", workspaceId!]).panes;
      const status = herdr(["pane", "get", rootPane!]).pane.agent_status;
      return panes.length === 1 && status !== "blocked" ? true : undefined;
    });
    assert.equal(parentResults(parentSessionFile).length, 1);
    const versionRows = await waitFor("parent and child versions", () => lines(versions).length >= 2 ? lines(versions) : undefined);
    assert.equal(versionRows.length, 2);
    assert.equal(versionRows.every((row: any) => row.version === "0.85.1"), true);
    completed = true;
  } finally {
    if (existsSync(temp)) cpSync(temp, join(forensicDir, "run"), { recursive: true });
    writeFileSync(join(forensicDir, "result.json"), `${JSON.stringify({ completed, recordedAt: new Date().toISOString(), workspaceId, rootPane, parentPid, childPid, workingTemp: temp }, null, 2)}\n`);
    if (workspaceId) {
      herdr(["workspace", "close", workspaceId]);
      await waitFor("owned workspace cleanup", () => workspaceIsGone(workspaceId!) ? true : undefined, 10_000);
    }
    if (parentPid) await waitFor("owned parent PID exit", () => !alive(parentPid!) ? true : undefined, 10_000);
    if (childPid) await waitFor("owned child PID exit", () => !alive(childPid!) ? true : undefined, 10_000);
    writeFileSync(join(forensicDir, "cleanup.json"), `${JSON.stringify({ workspaceGone: workspaceId ? workspaceIsGone(workspaceId) : true, parentGone: parentPid ? !alive(parentPid) : null, childGone: childPid ? !alive(childPid) : null }, null, 2)}\n`);
    rmSync(temp, { recursive: true, force: true });
  }
});


it("keeps sibling ownership through termination, auto-exit, and resume", { skip: !enabled, timeout: 120_000 }, async (t) => {
  assert.equal(process.env.HERDR_ENV, "1");
  assert.equal(execFileSync(exactPi, ["--version"], { encoding: "utf8" }).trim(), "0.85.1");
  const temp = mkdtempSync(join(tmpdir(), "pi-herdr-siblings-"));
  const agentDir = join(temp, "agent");
  const sessions = join(temp, "sessions");
  const events = join(temp, "events.jsonl");
  const versions = join(temp, "versions.jsonl");
  const siblingRelease = join(temp, "release-b");
  const evidenceBase = process.env.PI_TEST_EVIDENCE_DIR ?? tmpdir();
  mkdirSync(evidenceBase, { recursive: true });
  const forensicDir = mkdtempSync(join(evidenceBase, "pi-herdr-siblings-evidence-"));
  t.diagnostic(`Herdr sibling evidence: ${forensicDir}`);
  let workspaceId: string | undefined;
  let rootPane: string | undefined;
  let parentPid: number | undefined;
  const childPids: number[] = [];
  let parentSessionFile: string | undefined;
  let completed = false;
  try {
    for (const dir of ["agents", "extensions", "packages", "models", "skills/matrix-first", "skills/matrix-second"]) mkdirSync(join(agentDir, dir), { recursive: true });
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(agentDir, "skills", "matrix-first", "SKILL.md"), "---\nname: matrix-first\ndescription: deterministic first marker\n---\nMATRIX_SKILL_FIRST\n");
    writeFileSync(join(agentDir, "skills", "matrix-second", "SKILL.md"), "---\nname: matrix-second\ndescription: deterministic second marker\n---\nMATRIX_SKILL_SECOND\n");
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [], extensions: [sourceExtension] })}\n`);
    writeFileSync(join(agentDir, "models.json"), "{\"providers\":{}}\n");
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-provider.ts"), readFileSync(providerExtension, "utf8"));
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-config.json"), `${JSON.stringify({ eventsFile: events, gateFile: join(temp, "unused-gate"), releaseFile: join(temp, "unused-release"), versionsFile: versions, siblingReleaseFile: siblingRelease, scenario: "siblings" }, null, 2)}\n`);
    writeFileSync(join(agentDir, "agents", "deterministic-held-child.md"), `---\nname: deterministic-held-child\ndescription: held sibling\nmodel: deterministic-herdr/probe\ntools: none\nskills: matrix-first,matrix-second\nspawning: false\nauto-exit: false\nsystem-prompt: append\ndisable-model-invocation: true\n---\nHold until terminated.\n`);
    writeFileSync(join(agentDir, "agents", "deterministic-auto-child.md"), `---\nname: deterministic-auto-child\ndescription: auto-exit sibling\nmodel: deterministic-herdr/probe\ntools: none\nskills: matrix-first\nspawning: false\nauto-exit: true\nsession-mode: fork\ndisable-model-invocation: true\n---\nHold until released, then finish.\n`);
    const created = herdr(["workspace", "create", "--cwd", temp, "--label", `TEST deterministic-siblings ${Date.now()}`, "--env", "PATH=/opt/homebrew/bin:/usr/bin:/bin", "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SUBAGENT_MUX=herdr", "--no-focus"]);
    workspaceId = created.workspace.workspace_id;
    rootPane = created.root_pane.pane_id;
    const command = [
      "env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_FILE -u PI_SUBAGENT_ACTIVITY_FILE -u PI_SUBAGENT_NAME -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_SURFACE",
      `${JSON.stringify(exactPi)} -ne`, `-e ${JSON.stringify(sourceExtension)}`, `-e ${JSON.stringify(managedHerdr)}`, `-e ${JSON.stringify(providerExtension)}`,
      "--offline --provider deterministic-herdr --model probe", `--session-dir ${JSON.stringify(sessions)}`,
      "--no-builtin-tools --tools subagent,subagent_interrupt,subagent_terminate,subagent_resume --no-skills --no-prompt-templates --no-context-files --no-themes",
      JSON.stringify("Launch both deterministic siblings and wait."),
    ].join(" ");
    herdr(["pane", "run", rootPane, command]);

    const held = await waitFor("both held siblings", () => {
      const rows = lines(events).filter(event => event.event === "child_stream_held");
      return rows.length === 2 ? rows : undefined;
    }, 30_000);
    const aHeld = held.find((event: any) => event.subagentName === "SiblingA");
    const bHeld = held.find((event: any) => event.subagentName === "SiblingB");
    assert.ok(aHeld && bHeld);
    childPids.push(aHeld.pid, bHeld.pid);
    const aRequest = childProviderRequests(events, "SiblingA")[0];
    const bRequest = childProviderRequests(events, "SiblingB")[0];
    const aUsers = aRequest.requestMessages.filter((message: any) => message.role === "user");
    const bUsers = bRequest.requestMessages.filter((message: any) => message.role === "user");
    assert.equal(aUsers.length, 1, "multiple skills and task must share one initial prompt");
    assert.equal(bUsers.length, 1, "one skill and task must share one initial prompt");
    const aInput = messageText(aUsers[0]);
    const bInput = messageText(bUsers[0]);
    for (const marker of ["MATRIX_SKILL_FIRST", "MATRIX_SKILL_SECOND", "hold sibling A"]) {
      assert.notEqual(aInput.indexOf(marker), -1, `SiblingA input must contain ${marker}`);
    }
    for (const marker of ["MATRIX_SKILL_FIRST", "hold sibling B until release"]) {
      assert.notEqual(bInput.indexOf(marker), -1, `SiblingB input must contain ${marker}`);
    }
    assert.ok(aInput.indexOf("MATRIX_SKILL_FIRST") < aInput.indexOf("MATRIX_SKILL_SECOND"));
    assert.ok(aInput.indexOf("MATRIX_SKILL_SECOND") < aInput.indexOf("hold sibling A"));
    assert.ok(bInput.indexOf("MATRIX_SKILL_FIRST") < bInput.indexOf("hold sibling B until release"));
    const parentStart = lines(events).find(event => event.event === "session_start" && event.subagentId === null);
    assert.ok(parentStart?.sessionFile);
    parentPid = parentStart.pid;
    parentSessionFile = parentStart.sessionFile;
    const spawnReceipts = lines(parentSessionFile).filter(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent");
    assert.equal(spawnReceipts.length, 2);
    const aSpawn = spawnReceipts.find(entry => entry.message.details.name === "SiblingA");
    const bSpawn = spawnReceipts.find(entry => entry.message.details.name === "SiblingB");
    assert.ok(aSpawn && bSpawn);
    assert.notEqual(aSpawn.message.details.id, bSpawn.message.details.id);
    assert.notEqual(aSpawn.message.details.surface, bSpawn.message.details.surface);
    assert.notEqual(aSpawn.message.details.sessionFile, bSpawn.message.details.sessionFile);
    assert.equal(lines(bSpawn.message.details.sessionFile)[0].parentSession, parentSessionFile);
    assert.equal(herdr(["pane", "get", rootPane]).pane.agent_status, "blocked");

    herdr(["pane", "send-text", rootPane, "fixture interrupt A"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    await waitFor("sibling A abort", () => lines(events).find(event => event.event === "child_stream_aborted" && event.subagentName === "SiblingA"));
    await waitFor("sibling A resumable session", () => existsSync(aSpawn.message.details.sessionFile) ? true : undefined);
    assert.equal(alive(aHeld.pid), true);

    herdr(["pane", "send-text", rootPane, "fixture terminate A"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    await waitFor("sibling A exit", () => !alive(aHeld.pid) ? true : undefined);
    const aResult = await waitFor("only sibling A result", () => {
      const results = parentResults(parentSessionFile!);
      return results.length === 1 && results[0].details.name === "SiblingA" ? results[0] : undefined;
    });
    assert.notEqual(aResult.details.exitCode, 0);
    assert.equal(aResult.details.error, "terminated");
    assert.match(aResult.content, /terminated by parent request/i);
    assert.doesNotMatch(aResult.content, /provider\/agent error|auto-retry exhausted/i);
    const aSnapshotPath = await waitFor("sibling A snapshot", () => findOne(sessions, `${aHeld.subagentId}.child.json`));
    const aWrapperPath = aSnapshotPath.replace(/\.child\.json$/, ".wrapper.json");
    if (existsSync(aWrapperPath)) {
      // A graceful return may let the wrapper finish before Herdr closes it.
      const aWrapper = JSON.parse(readFileSync(aWrapperPath, "utf8"));
      assert.equal(aWrapper.runId, aHeld.subagentId);
      assert.equal(aWrapper.sourceId, `wrapper:${aHeld.subagentId}`);
      assert.deepEqual(Object.keys(aWrapper.exit).sort(), ["kind", "shellStatus"]);
      assert.equal(aWrapper.exit.kind, "shell");
      assert.ok(Number.isInteger(aWrapper.exit.shellStatus) && aWrapper.exit.shellStatus >= 0 && aWrapper.exit.shellStatus <= 255);
    }
    assert.equal(alive(bHeld.pid), true);
    const panesWithB = herdr(["pane", "list", "--workspace", workspaceId]).panes;
    assert.equal(panesWithB.some((pane: any) => pane.pane_id === bSpawn.message.details.surface), true);
    assert.equal(panesWithB.some((pane: any) => pane.pane_id === aSpawn.message.details.surface), false);
    assert.equal(herdr(["pane", "get", rootPane]).pane.agent_status, "blocked");
    const terminateReceipt = lines(parentSessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent_terminate");
    assert.ok(["termination_requested_unconfirmed", "terminated"].includes(terminateReceipt?.message.details?.status));

    writeFileSync(siblingRelease, "release\n");
    const bSettled = await waitFor("sibling B settlement", () => lines(events).find(event => event.event === "agent_settled" && event.subagentName === "SiblingB"));
    const bSnapshotPath = await waitFor("sibling B snapshot", () => findOne(sessions, `${bHeld.subagentId}.child.json`));
    const bWrapperPath = bSnapshotPath.replace(/\.child\.json$/, ".wrapper.json");
    await waitFor("sibling B wrapper", () => existsSync(bWrapperPath) ? true : undefined);
    await waitFor("sibling B result", () => parentResults(parentSessionFile!).some(result => result.details.name === "SiblingB") ? true : undefined);
    const bSnapshot = JSON.parse(readFileSync(bSnapshotPath, "utf8"));
    const settledFact = bSnapshot.latestFacts.find((fact: any) => fact.kind === "agent-settled");
    const requestedFact = bSnapshot.latestFacts.find((fact: any) => fact.kind === "completion-requested" && fact.reason === "auto-exit");
    assert.ok(settledFact.sequence < requestedFact.sequence);
    assert.equal(JSON.parse(readFileSync(bWrapperPath, "utf8")).exit.shellStatus, 0);
    const bResults = parentResults(parentSessionFile).filter(result => result.details.name === "SiblingB");
    assert.equal(bResults.length, 1);
    assert.equal(bResults[0].details.exitCode, 0);
    assert.equal(bResults[0].details.sessionFile, bSpawn.message.details.sessionFile);
    assert.match(bResults[0].content, /SIBLING_B_RELEASED/);
    await waitFor("parent unblock after final sibling", () => herdr(["pane", "get", rootPane!]).pane.agent_status !== "blocked" ? true : undefined);

    herdr(["pane", "send-text", rootPane, "fixture resume A"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    const resumeReceipt = await waitFor("resume tool result", () => lines(parentSessionFile!).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent_resume"));
    assert.equal(resumeReceipt.message.details.name, "ResumedA");
    assert.equal(resumeReceipt.message.details.sessionPath, aSpawn.message.details.sessionFile);
    assert.notEqual(resumeReceipt.message.details.id, aSpawn.message.details.id);
    const resumedStart = await waitFor("resumed Pi start", () => lines(events).find(event => event.event === "session_start" && event.subagentName === "ResumedA"));
    childPids.push(resumedStart.pid);
    assert.notEqual(resumedStart.pid, aHeld.pid);
    assert.equal(resumedStart.sessionFile, aSpawn.message.details.sessionFile);
    assert.equal(resumedStart.agent, "deterministic-held-child");
    assert.equal(resumedStart.cwd, realpathSync(temp));
    assert.equal(resumedStart.agentDir, agentDir);
    assert.deepEqual(resumedStart.activeTools.sort(), ["caller_ping", "subagent_done"]);
    assert.deepEqual(
      resumedStart.deniedTools.split(",").sort(),
      ["subagent", "subagent_interrupt", "subagent_resume", "subagent_terminate", "subagents_list"].sort(),
    );
    const resumedPrompt = await waitFor("resumed system prompt", () => lines(events).find(event => event.event === "before_agent_start" && event.subagentName === "ResumedA"));
    assert.match(resumedPrompt.systemPrompt, /Hold until terminated\./);
    const resumePolicies = lines(aSpawn.message.details.sessionFile).filter(entry => entry.type === "custom" && entry.customType === "pi-interactive-subagents.resume-policy");
    assert.equal(resumePolicies.length, 1);
    assert.equal(resumePolicies[0].data.agent, "deterministic-held-child");
    assert.deepEqual(resumePolicies[0].data.activeTools, ["caller_ping", "subagent_done"]);
    const resumedResult = await waitFor("fresh resumed result", () => parentResults(parentSessionFile!).find(result => result.details.name === "ResumedA"));
    assert.equal(resumedResult.details.exitCode, 0);
    assert.equal(resumedResult.details.sessionFile, aSpawn.message.details.sessionFile);
    assert.match(resumedResult.content, /RESUMED_A_FRESH_RESULT/);
    assert.doesNotMatch(resumedResult.content, /Request was aborted|PARENT_LAUNCHING_CHILD/);
    const resumedSnapshot = await waitFor("resumed child snapshot", () => findOne(sessions, `${resumeReceipt.message.details.id}.child.json`));
    assert.notEqual(resumedSnapshot, aSnapshotPath, "resume must own a fresh sidecar path");
    assert.notEqual(resumedSnapshot, bSnapshotPath);
    assert.equal(JSON.parse(readFileSync(resumedSnapshot.replace(/\.child\.json$/, ".wrapper.json"), "utf8")).exit.shellStatus, 0);
    await waitFor("resumed child exit and parent unblock", () => {
      const panes = herdr(["pane", "list", "--workspace", workspaceId!]).panes;
      const status = herdr(["pane", "get", rootPane!]).pane.agent_status;
      return !alive(resumedStart.pid) && panes.length === 1 && status !== "blocked" ? true : undefined;
    });
    assert.equal(parentResults(parentSessionFile).filter(result => result.details.name === "ResumedA").length, 1);
    assert.equal(parentResults(parentSessionFile).length, 3);
    const versionRows = await waitFor("all sibling Pi versions", () => lines(versions).length >= 4 ? lines(versions) : undefined);
    assert.equal(versionRows.length, 4);
    assert.equal(versionRows.every((row: any) => row.version === "0.85.1"), true);
    completed = true;
  } finally {
    if (existsSync(temp)) cpSync(temp, join(forensicDir, "run"), { recursive: true });
    writeFileSync(join(forensicDir, "result.json"), `${JSON.stringify({ completed, recordedAt: new Date().toISOString(), workspaceId, rootPane, parentPid, childPids, workingTemp: temp }, null, 2)}\n`);
    if (workspaceId) {
      herdr(["workspace", "close", workspaceId]);
      await waitFor("owned workspace cleanup", () => workspaceIsGone(workspaceId!) ? true : undefined, 10_000);
    }
    if (parentPid) await waitFor("owned parent PID exit", () => !alive(parentPid!) ? true : undefined, 10_000);
    for (const pid of childPids) await waitFor(`owned child PID ${pid} exit`, () => !alive(pid) ? true : undefined, 10_000);
    writeFileSync(join(forensicDir, "cleanup.json"), `${JSON.stringify({ workspaceGone: workspaceId ? workspaceIsGone(workspaceId) : true, parentGone: parentPid ? !alive(parentPid) : null, childrenGone: childPids.map(pid => ({ pid, gone: !alive(pid) })) }, null, 2)}\n`);
    rmSync(temp, { recursive: true, force: true });
  }
});
