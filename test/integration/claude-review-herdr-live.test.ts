import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { confirmClaudeProcessGone, readClaudeProcessId } from "../../pi-extension/subagents/claude-transport.ts";
import { readWrapperExitRecord } from "../../pi-extension/subagents/completion.ts";

const managedRoles = process.env.PI_TEST_CLAUDE_MANAGED_ROLES === "approved";
const enabled = managedRoles || process.env.PI_TEST_CLAUDE_HERDR_SUBSCRIPTION === "approved";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pi = process.env.PI_TEST_PI_BINARY ?? join(root, "node_modules", ".bin", "pi");
const extension = process.env.PI_TEST_EXTENSION_PATH ?? join(root, "pi-extension", "subagents", "index.ts");
const provider = join(root, "test", "integration", "deterministic-herdr-provider.ts");
const herdrExtension = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");

function herdr(args: string[]): any {
  const output = execFileSync("herdr", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return output ? JSON.parse(output).result : {};
}
function entries(file: string): any[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function findFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? findFiles(path, suffix) : path.endsWith(suffix) ? [path] : [];
  });
}
async function until<T>(label: string, probe: () => T | undefined, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

it("delivers two bounded Claude review runs in Herdr", { skip: !enabled, timeout: 150_000 }, async (t) => {
  assert.equal(process.env.HERDR_ENV, "1");
  const temp = mkdtempSync(join(tmpdir(), "pi-claude-herdr-"));
  const work = join(temp, "work");
  const agentDir = join(temp, "agent");
  const sessions = join(temp, "sessions");
  const events = join(temp, "events.jsonl");
  const versions = join(temp, "versions.jsonl");
  const configFile = join(agentDir, "extensions", "deterministic-herdr-config.json");
  const config = { scenario: managedRoles ? "claude-managed-review" : "claude-review", eventsFile: events, versionsFile: versions,
    gateFile: join(temp, "gate"), releaseFile: join(temp, "release") };
  let workspaceId: string | undefined;
  let followupPane: string | undefined;
  let completed = false;
  const results = () => findFiles(sessions, ".jsonl").flatMap(file => entries(file)).filter(entry =>
    entry.type === "custom_message" && entry.customType === "subagent_result" && entry.details?.claudeSessionId);
  const command = [
    `${JSON.stringify(pi)} -ne`, `-e ${JSON.stringify(extension)}`, `-e ${JSON.stringify(herdrExtension)}`,
    `-e ${JSON.stringify(provider)}`, "--offline --provider deterministic-herdr --model probe",
    `--session-dir ${JSON.stringify(sessions)}`, "--no-builtin-tools --tools subagent",
    "--no-skills --no-prompt-templates --no-context-files --no-themes",
    JSON.stringify("Run the bounded Claude review fixture."),
  ].join(" ");
  try {
    for (const dir of [join(work, "src"), join(agentDir, "agents"), join(agentDir, "extensions"), join(agentDir, "models"), join(agentDir, "packages"), sessions]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(work, "src", "access.ts"), 'export const requiredHeader = "X-Access-V2";\n');
    writeFileSync(join(work, "src", "caller.ts"), 'export const sentHeader = "X-Access-V1";\n');
    writeFileSync(join(agentDir, "settings.json"), '{"packages":[]}\n');
    writeFileSync(join(agentDir, "models.json"), '{"providers":{}}\n');
    if (managedRoles) {
      for (const name of ["claude-reviewer", "claude-validator"]) {
        writeFileSync(join(agentDir, "agents", `${name}.md`),
          readFileSync(join(homedir(), ".pi", "agent", "agents", `${name}.md`), "utf8"));
      }
    } else {
      const role = readFileSync(join(root, "agents", "claude-code.md"), "utf8");
      assert.match(role, /^model: sonnet$/m);
      writeFileSync(join(agentDir, "agents", "claude-code.md"), role.replace(/^model: sonnet$/m, "model: haiku"));
    }
    writeFileSync(configFile, JSON.stringify(config));

    const created = herdr(["workspace", "create", "--cwd", work, "--label", "TEST Claude review", "--no-focus",
      "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SUBAGENT_MUX=herdr"]);
    workspaceId = created.workspace.workspace_id;
    herdr(["pane", "run", created.root_pane.pane_id, command]);
    await until("first Pi provider startup", () => entries(versions).filter(e => e.subagentId === null).length === 1 || undefined, 10_000);
    const first = await until("first Claude review result", () => results()[0]);
    const claudeSessionId: string = first.details.claudeSessionId;
    assert.match(first.content, /X-Access-V[12]/);
    assert.equal(first.details.exitCode, 0);

    writeFileSync(configFile, JSON.stringify({ ...config,
      scenario: managedRoles ? "claude-managed-validate" : "claude-resume",
      ...(managedRoles ? {} : { resumeSessionId: claudeSessionId }),
    }));
    const followupTab = herdr(["tab", "create", "--workspace", workspaceId, "--cwd", work, "--no-focus",
      "--env", `PI_CODING_AGENT_DIR=${agentDir}`, "--env", "PI_SUBAGENT_MUX=herdr"]);
    followupPane = followupTab.root_pane.pane_id;
    herdr(["pane", "run", followupPane, command]);
    await until("follow-up Pi provider startup", () => entries(versions).filter(e => e.subagentId === null).length === 2 || undefined, 10_000);
    const second = await until("second Claude review result", () => results().find(entry => entry.id !== first.id));
    if (managedRoles) assert.notEqual(second.details.claudeSessionId, claudeSessionId);
    else assert.equal(second.details.claudeSessionId, claudeSessionId);
    assert.equal(second.details.exitCode, 0);
    assert.match(second.content, /X-Access-V2/);
    if (managedRoles) assert.match(second.content, /FAIL/i);
    if (process.env.PI_TEST_PI_EXPECTED_VERSION) {
      assert.ok(entries(versions).filter(e => e.subagentId === null).every(e => e.version === process.env.PI_TEST_PI_EXPECTED_VERSION));
    }

    const wrapperFiles = findFiles(sessions, ".wrapper.json");
    const pidFiles = findFiles(sessions, ".claude.pid");
    assert.equal(wrapperFiles.length, 2);
    assert.equal(pidFiles.length, 2);
    if (managedRoles) {
      const scripts = findFiles(sessions, ".sh").map(file => readFileSync(file, "utf8"));
      assert.equal(scripts.length, 2);
      assert.ok(scripts.some(text => /--safe-mode --restricted/.test(text) && /--model 'sonnet'/.test(text)));
      assert.ok(scripts.some(text => /--safe-mode --restricted/.test(text) && /--model 'opus'/.test(text)));
    }
    for (const file of pidFiles) {
      const runId = readFileSync(file, "utf8").split(" ")[0];
      assert.ok(readClaudeProcessId(file, runId));
      assert.equal(confirmClaudeProcessGone(file, runId), true);
      const wrapper = wrapperFiles.find(path => path.endsWith(`${runId}.wrapper.json`));
      assert.ok(wrapper);
      const exit = readWrapperExitRecord(wrapper, runId);
      assert.equal(exit.ok, true);
      if (exit.ok) assert.equal(exit.value.exit.shellStatus, 0);
    }
    completed = true;
  } finally {
    if (!completed) {
      t.diagnostic(`Failure evidence retained at ${temp}; remove after inspection (agent/auth.json will be deleted).`);
      t.diagnostic(`Provider events: ${JSON.stringify(entries(events).slice(-8).map(e => ({ event: e.event, tool: e.toolName, child: e.child })))}`);
      t.diagnostic(`Claude results: ${JSON.stringify(results().map(e => ({ id: e.id, sessionId: e.details.claudeSessionId, exitCode: e.details.exitCode })))}`);
      if (followupPane) {
        try { t.diagnostic(`Follow-up pane status: ${JSON.stringify(herdr(["pane", "get", followupPane]))}`); }
        catch (error) { t.diagnostic(`Follow-up pane status unavailable: ${String(error)}`); }
      }
    }
    try {
      if (workspaceId) {
        herdr(["workspace", "close", workspaceId]);
        await until("Herdr workspace cleanup", () => {
          try { herdr(["workspace", "get", workspaceId!]); return undefined; }
          catch { return true; }
        }, 10_000);
      }
      const parentPids = entries(versions).filter(entry => entry.subagentId === null).map(entry => entry.pid);
      for (const pid of parentPids) await until("parent Pi process exit", () => {
        try { process.kill(pid, 0); return undefined; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
      }, 10_000);
    } finally {
      if (completed) rmSync(temp, { recursive: true, force: true });
      else rmSync(join(agentDir, "auth.json"), { force: true });
    }
  }
});
