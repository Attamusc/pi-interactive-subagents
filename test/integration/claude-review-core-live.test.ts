import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { confirmClaudeProcessGone, readClaudePrintResult, readClaudeProcessId } from "../../pi-extension/subagents/claude-transport.ts";
import { readWrapperExitRecord, readWrapperStartRecord } from "../../pi-extension/subagents/completion.ts";
import { coreRpcCall } from "../../pi-extension/subagents/herdr-core.ts";

const enabled = process.env.PI_TEST_CLAUDE_CORE_SUBSCRIPTION === "approved";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = join(root, "pi-extension/subagents/index.ts");
const provider = join(root, "test/integration/deterministic-herdr-provider.ts");

function entries(file: string): any[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}
function files(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path, suffix) : path.endsWith(suffix) ? [path] : [];
  });
}
function gone(pid: number): boolean {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function until<T>(label: string, probe: () => T | undefined, timeout = 55_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = probe();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`Timed out waiting for ${label}`);
}

// Run only after external review, under the caller's kernel PID cap and hard timeout.
// No fallback endpoint, GUI adoption, trust response, or credential copying is allowed.
it("auto-selects private Core over classic markers for managed Claude seats", {
  skip: !enabled, timeout: 180_000,
}, async t => {
  assert.equal(process.platform, "linux", "native Core smoke requires Linux cgroup v2");
  assert.equal(process.env.EXPECTED_TASK_CAP, "256", "external TasksMax=256 is required");
  const cgroup = readFileSync("/proc/self/cgroup", "utf8").split("\n").find(line => line.startsWith("0::"));
  assert.ok(cgroup, "native Core smoke requires a unified cgroup v2 membership");
  const taskCap = readFileSync(join("/sys/fs/cgroup", cgroup.slice(3), "pids.max"), "utf8").trim();
  assert.equal(taskCap, "256", "own cgroup pids.max must be exactly 256 before native startup");

  const temp = realpathSync(mkdtempSync(join(tmpdir(), "cc-")));
  const socket = join(temp, "c.sock");
  const agentDir = join(temp, "agent");
  const work = join(temp, "work");
  const sessions = join(temp, "sessions");
  const events = join(temp, "events.jsonl");
  const versions = join(temp, "versions.jsonl");
  const configFile = join(agentDir, "extensions/deterministic-herdr-config.json");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HC_|HERDR_|PI_)/.test(key) || ["BASH_ENV", "ENV", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"].includes(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: homedir(), HC_SESSION: `claude-smoke-${temp.split("/").at(-1)}`, HC_SOCKET: socket,
    XDG_CONFIG_HOME: join(temp, "config"), XDG_STATE_HOME: join(temp, "state"),
    XDG_RUNTIME_DIR: join(temp, "run"), XDG_DATA_HOME: join(temp, "data"), XDG_CACHE_HOME: join(temp, "cache"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
    HERDR_SOCKET_PATH: join(temp, "not-a-classic-socket"), HERDR_ENV: "1",
  });
  assert.equal(env.PI_SUBAGENT_MUX, undefined);
  assert.ok(env.HERDR_SOCKET_PATH);
  const ownedParents: any[] = [];
  const ownedChildren = new Map<string, any>();
  const ownedPids = new Set<number>();
  let coreId: string | undefined;
  let started = false;
  let completed = false;
  const command = (binary: string, args: string[]) => execFileSync(binary, args, {
    env, cwd: work, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const hc = (args: string[]): any => {
    const value = JSON.parse(command("hc", ["--json", ...args]));
    assert.ok(!value.error, JSON.stringify(value.error));
    return value;
  };
  const list = () => (hc(["ls", "--all"]).terminals as any[]).map(record => hc(["get", record.address]));
  const save = () => writeFileSync(join(temp, "ownership.json"), JSON.stringify({
    coreId, socket, parents: ownedParents, children: [...ownedChildren.values()], pids: [...ownedPids],
  }, null, 2));
  const capture = () => {
    const status = hc(["server", "status"]);
    assert.equal(status.core.id, coreId);
    ownedPids.add(status.pid);
    for (const holder of status.holders) ownedPids.add(holder.pid);
    for (const file of files(sessions, ".wrapper-start.json")) {
      const start = JSON.parse(readFileSync(file, "utf8"));
      if (ownedChildren.has(start.address)) continue;
      assert.equal(readWrapperStartRecord(file, start.runId, start.address).ok, true);
      const record = list().find(record => record.address === start.address);
      assert.ok(record, "must capture child registry identity before removal");
      assert.ok(ownedParents.some(parent => parent.address === record.parent));
      assert.equal(record.labels["pi.subagent.run"], start.runId);
      ownedChildren.set(start.address, { ...record, runId: start.runId, wrapperPid: start.wrapperPid });
      ownedPids.add(start.wrapperPid);
      if (record.pid) ownedPids.add(record.pid);
    }
    for (const file of files(sessions, ".claude.pid")) {
      const runId = readFileSync(file, "utf8").split(" ")[0];
      const pid = readClaudeProcessId(file, runId);
      assert.ok(pid); ownedPids.add(pid);
    }
    save();
  };
  try {
    for (const dir of [work, sessions, join(work, "src"), join(agentDir, "agents"), join(agentDir, "extensions"),
      ...["config", "state", "run", "data", "cache"].map(dir => join(temp, dir))]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, "settings.json"), '{"packages":[]}\n');
    writeFileSync(join(agentDir, "models.json"), '{"providers":{}}\n');
    mkdirSync(join(env.XDG_CONFIG_HOME!, "herdr-core"));
    writeFileSync(join(env.XDG_CONFIG_HOME!, "herdr-core/config.toml"), 'notes = false\nshell = ["/bin/bash", "--noprofile", "--norc"]\n');
    writeFileSync(join(work, "src/access.ts"), 'export const requiredHeader = "X-Access-V2";\n');
    writeFileSync(join(work, "src/caller.ts"), 'export const sentHeader = "X-Access-V1";\n');
    for (const name of ["claude-reviewer", "claude-validator"]) {
      writeFileSync(join(agentDir, "agents", `${name}.md`), readFileSync(join(homedir(), ".pi/agent/agents", `${name}.md`), "utf8"));
    }
    const bin = join(temp, "bin"); mkdirSync(bin);
    const forbiddenCalls = join(temp, "forbidden-classic-calls");
    for (const binary of ["herdr", "herdr-app", "cmux", "tmux", "zellij", "wezterm"]) {
      writeFileSync(join(bin, binary), `#!/bin/bash\nprintf '%s\\n' '${binary}' >> '${forbiddenCalls}'\nexit 99\n`, { mode: 0o700 });
    }
    env.PATH = `${bin}:${env.PATH ?? ""}`;
    const piPackage = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent"));
    const manifest = JSON.parse(readFileSync(join(piPackage, "package.json"), "utf8"));
    assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
    const entry = realpathSync(join(piPackage, manifest.bin.pi));
    const piVersion = command(process.execPath, [entry, "--version"]);
    const coreVersion = command("hc", ["--version"]);
    assert.equal(piVersion, "1.5.0");
    assert.match(coreVersion, /\b0\.1\.21\b/);
    writeFileSync(join(temp, "versions.json"), JSON.stringify({ node: process.version, pi: piVersion, hc: coreVersion, entry }));
    assert.equal(existsSync(socket), false);
    hc(["server", "start"]);
    assert.ok(lstatSync(socket).isSocket(), "scratch Core must create its explicit private socket");
    const hello: any = await coreRpcCall(socket, "hello", { generation: 1 });
    const status = hc(["server", "status"]);
    assert.equal(status.core.id, hello.core.id, "hc must target the verified private socket");
    assert.equal(status.version, "0.1.21");
    coreId = status.core.id;
    started = true;
    ownedPids.add(status.pid);
    for (const holder of status.holders) ownedPids.add(holder.pid);
    assert.deepEqual(list(), []);
    save();
    for (const scenario of ["claude-managed-review", "claude-managed-validate"]) {
      const parentSessions = join(sessions, scenario);
      mkdirSync(parentSessions, { mode: 0o700 });
      writeFileSync(configFile, JSON.stringify({ scenario, eventsFile: events, versionsFile: versions,
        gateFile: join(temp, "gate"), releaseFile: join(temp, "release") }));
      const parent = hc(["run", "--bg", "--no-parent", "--no-notify", "--name", scenario,
        "--cwd", work, "/usr/bin/env", "-u", "PI_SUBAGENT_MUX", `HERDR_SOCKET_PATH=${env.HERDR_SOCKET_PATH}`, "HERDR_ENV=1", `PATH=${env.PATH}`, process.execPath, entry, "-ne", "-e", extension, "-e", provider,
        "--offline", "--no-approve", "--no-mcp", "--provider", "deterministic-herdr", "--model", "probe",
        "--session-dir", parentSessions, "--no-builtin-tools", "--tools", "subagent", "--no-skills",
        "--no-prompt-templates", "--no-context-files", "--no-themes", "Run the bounded Claude review fixture."]);
      writeFileSync(join(temp, `${scenario}.launch.json`), JSON.stringify(parent, null, 2));
      assert.match(parent.address, /^t[0-9a-z]+$/);
      ownedParents.push(parent); save();
      const record = await until("parent process identity", () => {
        const current = hc(["get", parent.address]);
        return Number.isSafeInteger(current.pid) && current.pid > 1 ? current : undefined;
      }, 3000);
      Object.assign(parent, record);
      ownedPids.add(parent.pid); save();
      const runningStatus = hc(["server", "status"]);
      assert.equal(runningStatus.core.id, coreId);
      assert.ok(runningStatus.holders.length > 0);
      for (const holder of runningStatus.holders) ownedPids.add(holder.pid);
      save();
      const index = ownedParents.length - 1;
      await until("native Pi startup", () => entries(versions).length === index + 1 || undefined, 10_000);
      const result = await until("native parent result delivery", () => {
        capture();
        return files(parentSessions, ".jsonl").flatMap(entries).find(entry => entry.type === "custom_message" &&
          entry.customType === "subagent_result" && entry.details?.claudeSessionId);
      });
      const emitted = entries(events).find(event => event.pid === parent.pid && event.event === "provider_emitted_tool_call");
      assert.ok(emitted, "must observe the actual parent just before its subagent call");
      assert.deepEqual(emitted.runtimeEnvironment, { legacySocket: env.HERDR_SOCKET_PATH, legacyEnv: "1", explicitMux: null, pathFirst: bin });
      assert.equal(result.details.exitCode, 0);
      assert.match(result.details.claudeSessionId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
      assert.match(result.content, /X-Access-V2/);
      if (index === 1) assert.match(result.content, /FAIL/i);
      await until("parent consumed delivered result", () => entries(events).filter(event => event.pid === parent.pid && event.event === "provider_invoked" &&
        event.requestMessages?.some((message: any) => JSON.stringify(message).includes(result.details.claudeSessionId))).length > 0 || undefined, 5000);
    }
    capture();
    assert.equal(existsSync(forbiddenCalls), false, "no classic multiplexer or app calls allowed");
    assert.equal(ownedChildren.size, 2);
    assert.equal(files(sessions, ".claude-result.json").length, 2);
    const calls = entries(events).filter(event => event.event === "provider_emitted_tool_call");
    assert.deepEqual(calls.map(event => event.toolCallArguments.agent), ["claude-reviewer", "claude-validator"]);
    assert.ok(entries(versions).every(entry => entry.version === "1.5.0" && entry.subagentId === null));
    const nativeIds = new Set<string>();
    for (const child of ownedChildren.values()) {
      const nativeResult = readClaudePrintResult(files(sessions, `${child.runId}.claude-result.json`)[0]);
      assert.ok(nativeResult.summary.trim());
      assert.match(nativeResult.summary, /X-Access-V2/);
      nativeIds.add(nativeResult.sessionId);
      const wrapper = files(sessions, `${child.runId}.wrapper.json`)[0];
      const exit = readWrapperExitRecord(wrapper, child.runId);
      assert.ok(exit.ok); if (exit.ok) assert.equal(exit.value.exit.shellStatus, 0);
      const pidFile = files(sessions, `${child.runId}.claude.pid`)[0];
      assert.equal(confirmClaudeProcessGone(pidFile, child.runId), true);
      assert.ok(!list().some(record => record.address === child.address), "extension must remove child Core record");
    }
    assert.equal(nativeIds.size, 2);
    const deliveredIds = files(sessions, ".jsonl").flatMap(entries).filter(entry => entry.type === "custom_message" &&
      entry.customType === "subagent_result").map(entry => entry.details?.claudeSessionId);
    assert.deepEqual(new Set(deliveredIds), nativeIds);
    const scripts = files(sessions, ".sh").map(file => readFileSync(file, "utf8"));
    assert.equal(scripts.length, 2);
    for (const script of scripts) {
      assert.match(script, /--safe-mode --restricted --strict-mcp-config --permission-mode dontAsk/);
      assert.match(script, /--tools 'Read,Glob,Grep' --allowedTools 'Read' 'Glob' 'Grep' --disallowedTools 'mcp__\*'/);
      assert.ok(script.includes(process.execPath));
    }
    completed = true;
  } catch (error) {
    t.diagnostic(`Primary native smoke error: ${String(error).slice(0, 2000)}`);
    throw error;
  } finally {
    try {
      if (started) {
        assert.equal(hc(["server", "status"]).core.id, coreId, "scratch Core identity changed; retain everything");
        const records = list();
        const known = new Set([...ownedParents.map(parent => parent.address), ...ownedChildren.keys()]);
        assert.ok(records.every(record => known.has(record.address)), "unknown terminal: retain Core for human inspection");
        for (const record of records) {
          if (record.state === "live") hc(["kill", record.address]);
          await until("owned terminal finished", () => hc(["get", record.address]).state === "finished" || undefined, 3000);
          hc(["rm", record.address]);
        }
        assert.deepEqual(list(), []);
        hc(["server", "stop"]);
        await until("owned socket and all known native PIDs gone", () => !existsSync(socket) && files(temp, "").every(file => !lstatSync(file).isSocket()) && [...ownedPids].every(gone) || undefined, 5000);
        save();
      }
      assert.ok(completed, "native evidence incomplete");
      rmSync(temp, { recursive: true });
    } catch (error) {
      t.diagnostic(`Evidence retained at ${temp}; no unknown processes or endpoints were removed.`);
      throw error;
    }
  }
});
