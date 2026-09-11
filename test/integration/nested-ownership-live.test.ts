import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

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
  return complete ? complete.split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
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

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findOne(dir: string, predicate: (path: string) => boolean): string | undefined {
  if (!existsSync(dir)) return undefined;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const entry = join(current, name);
      if (predicate(entry)) return entry;
      if (statSync(entry).isDirectory()) stack.push(entry);
    }
  }
  return undefined;
}

function parentResults(sessionFile: string): any[] {
  return lines(sessionFile).filter(entry => entry.type === "custom_message" && entry.customType === "subagent_result");
}

it("keeps an autonomous direct owner alive until its nested child completes", { skip: !enabled, timeout: 120_000 }, async (t) => {
  assert.equal(process.env.HERDR_ENV, "1");
  assert.equal(execFileSync(exactPi, ["--version"], { encoding: "utf8" }).trim(), "0.85.1");

  const temp = mkdtempSync(join(tmpdir(), "pi-herdr-nested-"));
  const agentDir = join(temp, "agent");
  const sessions = join(temp, "sessions");
  const events = join(temp, "events.jsonl");
  const versions = join(temp, "versions.jsonl");
  const release = join(temp, "release-grandchild");
  const invalidSession = join(temp, "untrusted-session.jsonl");
  const evidenceBase = process.env.PI_TEST_EVIDENCE_DIR ?? tmpdir();
  mkdirSync(evidenceBase, { recursive: true });
  const forensicDir = mkdtempSync(join(evidenceBase, "pi-herdr-nested-evidence-"));
  t.diagnostic(`Herdr nested ownership evidence: ${forensicDir}`);

  let workspaceId: string | undefined;
  let rootPane: string | undefined;
  let rootPid: number | undefined;
  const childPids: number[] = [];
  let completed = false;
  try {
    for (const dir of ["agents", "extensions", "packages", "models"]) mkdirSync(join(agentDir, dir), { recursive: true });
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [], extensions: [sourceExtension] })}\n`);
    writeFileSync(join(agentDir, "models.json"), "{\"providers\":{}}\n");
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-provider.ts"), readFileSync(providerExtension, "utf8"));
    writeFileSync(invalidSession, `${JSON.stringify({ type: "session", version: 3, id: "untrusted", timestamp: new Date().toISOString(), cwd: temp })}\n`);
    writeFileSync(join(agentDir, "extensions", "deterministic-herdr-config.json"), `${JSON.stringify({
      eventsFile: events,
      gateFile: join(temp, "unused-gate"),
      releaseFile: join(temp, "unused-release"),
      versionsFile: versions,
      siblingReleaseFile: release,
      invalidSessionFile: invalidSession,
      scenario: "nested",
    }, null, 2)}\n`);
    writeFileSync(join(agentDir, "agents", "deterministic-orchestrator.md"), `---\nname: deterministic-orchestrator\ndescription: nested owner\nmodel: deterministic-herdr/probe\ntools: subagent\nspawning: true\nauto-exit: true\ndisable-model-invocation: true\n---\nLaunch one child and wait for its result.\n`);
    writeFileSync(join(agentDir, "agents", "deterministic-grandchild.md"), `---\nname: deterministic-grandchild\ndescription: held nested child\nmodel: deterministic-herdr/probe\ntools: none\nspawning: false\nauto-exit: true\ndisable-model-invocation: true\n---\nWait until released.\n`);

    const created = herdr(["workspace", "create", "--cwd", temp, "--label", `TEST deterministic-nested ${Date.now()}`, "--env", "PATH=/opt/homebrew/bin:/usr/bin:/bin", "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SUBAGENT_MUX=herdr", "--no-focus"]);
    workspaceId = created.workspace.workspace_id;
    rootPane = created.root_pane.pane_id;
    const command = [
      "env -u PI_SUBAGENT_ID -u PI_SUBAGENT_SESSION -u PI_SUBAGENT_COMPLETION_FILE -u PI_SUBAGENT_ACTIVITY_FILE -u PI_SUBAGENT_NAME -u PI_SUBAGENT_AGENT -u PI_SUBAGENT_SURFACE",
      `${JSON.stringify(exactPi)} -ne`, `-e ${JSON.stringify(sourceExtension)}`, `-e ${JSON.stringify(managedHerdr)}`, `-e ${JSON.stringify(providerExtension)}`,
      "--offline --provider deterministic-herdr --model probe", `--session-dir ${JSON.stringify(sessions)}`,
      "--no-builtin-tools --tools subagent,subagent_terminate,subagent_resume --no-skills --no-prompt-templates --no-context-files --no-themes",
      JSON.stringify("Launch the deterministic orchestrator."),
    ].join(" ");
    herdr(["pane", "run", rootPane, command]);

    const grandchildHeld = await waitFor("held grandchild", () => lines(events).find(event => event.event === "child_stream_held" && event.subagentName === "Grandchild"), 30_000);
    childPids.push(grandchildHeld.pid);
    const rootStart = lines(events).find(event => event.event === "session_start" && event.subagentId === null);
    const orchestratorStart = lines(events).find(event => event.event === "session_start" && event.subagentName === "Orchestrator");
    assert.ok(rootStart?.sessionFile && orchestratorStart?.sessionFile);
    rootPid = rootStart.pid;
    childPids.push(orchestratorStart.pid);

    const orchestratorSpawn = await waitFor("orchestrator spawn receipt", () => lines(rootStart.sessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent" && entry.message.details?.name === "Orchestrator"));
    const grandchildSpawn = await waitFor("grandchild spawn receipt", () => lines(orchestratorStart.sessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent" && entry.message.details?.name === "Grandchild"));
    assert.notEqual(orchestratorSpawn.message.details.id, grandchildSpawn.message.details.id);

    const orchestratorActivity = await waitFor("orchestrator ownership activity", () => findOne(sessions, path => path.includes("subagent-activity") && path.endsWith(`/${orchestratorSpawn.message.details.id}.json`)));
    await waitFor("direct child count", () => JSON.parse(readFileSync(orchestratorActivity, "utf8")).directChildCount === 1 ? true : undefined);
    await waitFor("orchestrator settled while child runs", () => lines(events).find(event => event.event === "agent_settled" && event.subagentName === "Orchestrator"));
    assert.equal(alive(orchestratorStart.pid), true);
    assert.equal(alive(grandchildHeld.pid), true);
    assert.equal(parentResults(rootStart.sessionFile).some(result => result.details.name === "Orchestrator"), false);

    herdr(["pane", "send-text", rootPane, "fixture ancestor terminate grandchild"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    const ancestorReceipt = await waitFor("ancestor ownership rejection", () => lines(rootStart.sessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "terminate-grandchild"));
    assert.match(ancestorReceipt.message.content[0].text, /No running subagent named "Grandchild"/);
    assert.equal(alive(grandchildHeld.pid), true);

    herdr(["pane", "send-text", rootPane, "fixture terminate orchestrator"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    const ownerReceipt = await waitFor("live ownership termination rejection", () => lines(rootStart.sessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "terminate-orchestrator"));
    assert.equal(ownerReceipt.message.details.error, "owned-subagents-active");
    assert.equal(ownerReceipt.message.details.directChildCount, 1);
    assert.equal(alive(orchestratorStart.pid), true);
    assert.equal(alive(grandchildHeld.pid), true);

    writeFileSync(release, "release\n");
    const orchestratorResult = await waitFor("orchestrator result", () => parentResults(rootStart.sessionFile).find(result => result.details.name === "Orchestrator"));
    assert.equal(orchestratorResult.details.exitCode, 0);
    assert.match(orchestratorResult.content, /ORCHESTRATOR_WAITING_FOR_CHILD/);
    await waitFor("nested processes and panes exit", () => {
      const panes = herdr(["pane", "list", "--workspace", workspaceId!]).panes;
      return !alive(orchestratorStart.pid) && !alive(grandchildHeld.pid) && panes.length === 1 ? true : undefined;
    });
    assert.equal(JSON.parse(readFileSync(orchestratorActivity, "utf8")).directChildCount, 0);

    const panesBeforeInvalidResume = herdr(["pane", "list", "--workspace", workspaceId]).panes.map((pane: any) => pane.pane_id).sort();
    herdr(["pane", "send-text", rootPane, "fixture invalid resume"]);
    herdr(["pane", "send-keys", rootPane, "enter"]);
    const invalidReceipt = await waitFor("untrusted resume rejection", () => lines(rootStart.sessionFile).find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "invalid-resume"));
    assert.equal(invalidReceipt.message.details.error, "invalid resume policy");
    assert.match(invalidReceipt.message.content[0].text, /missing trusted resume policy/);
    const panesAfterInvalidResume = herdr(["pane", "list", "--workspace", workspaceId]).panes.map((pane: any) => pane.pane_id).sort();
    assert.deepEqual(panesAfterInvalidResume, panesBeforeInvalidResume, "invalid provenance must fail before pane creation");
    completed = true;
  } finally {
    if (existsSync(temp)) cpSync(temp, join(forensicDir, "run"), { recursive: true });
    writeFileSync(join(forensicDir, "result.json"), `${JSON.stringify({ completed, recordedAt: new Date().toISOString(), workspaceId, rootPane, rootPid, childPids }, null, 2)}\n`);
    if (workspaceId) {
      herdr(["workspace", "close", workspaceId]);
      await waitFor("owned workspace cleanup", () => {
        try { herdr(["workspace", "get", workspaceId!]); return undefined; } catch { return true; }
      }, 10_000);
    }
    if (rootPid) await waitFor("root PID exit", () => !alive(rootPid!) ? true : undefined, 10_000);
    for (const pid of childPids) await waitFor(`child PID ${pid} exit`, () => !alive(pid) ? true : undefined, 10_000);
    writeFileSync(join(forensicDir, "cleanup.json"), `${JSON.stringify({
      workspaceGone: workspaceId ? (() => { try { herdr(["workspace", "get", workspaceId!]); return false; } catch { return true; } })() : true,
      rootGone: rootPid ? !alive(rootPid) : null,
      childrenGone: childPids.map(pid => ({ pid, gone: !alive(pid) })),
    }, null, 2)}\n`);
    rmSync(temp, { recursive: true, force: true });
  }
});
