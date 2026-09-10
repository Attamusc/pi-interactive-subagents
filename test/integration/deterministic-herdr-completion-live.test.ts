import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const complete = body.endsWith("\n") ? body.slice(0, -1) : body.slice(0, body.lastIndexOf("\n"));
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
    if (stderr.includes('"code":"workspace_not_found"')) return true;
    throw error;
  }
}
function parentResults(sessionFile: string): any[] {
  return lines(sessionFile).filter(entry => entry.type === "custom_message" && entry.customType === "subagent_result");
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
    assert.match(delivered[0].content, /CHILD_POST_TOOL_STOP/);
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
