import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { createChildCompletionRecorder } from "../pi-extension/subagents/completion.ts";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { getMuxBackend, muxSetupHint } from "../pi-extension/subagents/cmux.ts";

it("selects explicit Core without classic fallback and requires inherited identity", () => {
  const saved = { ...process.env };
  try {
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    delete process.env.HC_TERMINAL_SOCKET;
    delete process.env.HC_TERMINAL_ID;
    assert.equal(getMuxBackend(), null);
    process.env.HC_TERMINAL_SOCKET = "/fake/core.sock";
    process.env.HC_TERMINAL_ID = "t1";
    assert.equal(getMuxBackend(), "herdr-core");
    assert.match(muxSetupHint(), /Core/);
  } finally { process.env = saved; }
});

async function coreFixture(run: (fixture: any) => Promise<void>) {
  const saved = { ...process.env };
  const originalArgv = process.argv[1];
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cl-")));
  const requests: any[] = [];
  const stateFile = join(dir, "app.json");
  const appLog = join(dir, "app.log");
  const parent = { address: "t1", state: "live", pid: 123, argv: ["/bin/zsh"], parent: null,
    labels: { "herdr.space": "space-test", "herdr.tab": "parent-tab" } };
  let child: any;
  const server = createServer(socket => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer);
      requests.push(request);
      let result: any;
      switch (request.method) {
        case "hello": result = { generation: 1, core: { id: "test-core" }, methods: ["terminal.run", "terminal.get", "terminal.list", "terminal.read", "terminal.keys", "terminal.kill", "terminal.rm"] }; break;
        case "terminal.get": result = request.params.terminal === "t1" ? parent : child; break;
        case "terminal.run":
          child = { address: "t2", state: "live", pid: 456, argv: request.params.argv, parent: "t1", labels: request.params.labels };
          writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), child: true, name: "" }));
          result = child; break;
        case "terminal.kill": child = { ...child, state: "finished", pid: null, exit_code: 143 }; result = child; break;
        case "terminal.rm":
          if (JSON.parse(readFileSync(stateFile, "utf8")).rmFails) {
            socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture remove failure", data: { kind: "busy" } } }) + "\n"); return;
          }
          result = { removed: "t2" }; break;
        case "terminal.keys": result = { turn: 1 }; break;
        case "terminal.read": result = { text: "partial", complete: true }; break;
        default: throw new Error(`unexpected RPC ${request.method}`);
      }
      socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    });
  });
  try {
    __test__.ensureModuleAbortController();
    const bin = join(dir, "bin"); mkdirSync(bin);
    const packageDir = join(dir, "pi-package"); mkdirSync(packageDir);
    const entry = join(packageDir, "cli.js"); writeFileSync(entry, "// fake Pi entrypoint\n");
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "fixture", bin: { pi: "cli.js" } }));
    process.argv[1] = entry;
    writeFileSync(stateFile, JSON.stringify({ child: false }));
    writeFileSync(join(bin, "herdr-app"), `#!${process.execPath}\nconst fs=require('node:fs');const file=${JSON.stringify(stateFile)};const log=${JSON.stringify(appLog)};const args=process.argv.slice(2);fs.appendFileSync(log,JSON.stringify({args,home:process.env.HERDR_APP_HOME})+'\\n');const state=JSON.parse(fs.readFileSync(file));const visibleChild=state.child&&!(state.adoptPending>0);if(state.child&&state.adoptPending>0&&args[0]==='ls'){state.adoptPending--;fs.writeFileSync(file,JSON.stringify(state));}let result;if(args[0]==='ls')result={spaces:[{id:'space-test',machine:null,tabs:[{id:'parent-tab',name:'parent',terminals:[{terminal:state.badParent?'t9':'t1',pane:'parent-pane'}]},...(visibleChild?[{id:'child-tab',name:state.name,terminals:[{terminal:'t2',pane:'child-pane'}]}]:[])]}]};else if(args[0]==='status')result={space:'space-test',tab:'parent-tab'};else if(args[0]==='do'&&args[1]==='tab.rename'){const rename=JSON.parse(args[2]);if(rename.id!=='child-tab')throw Error('wrong tab');state.name=rename.name;fs.writeFileSync(file,JSON.stringify(state));result=state.renameFails?{error:'fixture rename failure'}:{ok:true};}else throw Error('forbidden app command');console.log(JSON.stringify(result));\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.HERDR_APP_HOME = join(dir, "selected-app");
    process.env.PI_CODING_AGENT_DIR = join(dir, "profile"); mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    process.env.HC_TERMINAL_ID = "t1";
    process.env.HC_TERMINAL_SOCKET = join(dir, "api.sock");
    const session = join(dir, "parent.jsonl"); writeFileSync(session, JSON.stringify({ type: "session", id: "parent", cwd: dir }) + "\n");
    server.listen(process.env.HC_TERMINAL_SOCKET); await once(server, "listening");
    await run({ dir, entry, requests, parent, appLog, stateFile, ctx: { cwd: dir, sessionManager: { getSessionFile: () => session, getSessionId: () => "parent", getSessionDir: () => dir } } });
  } finally {
    process.env = saved; process.argv[1] = originalArgv;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

it("resumes through the registered tool using immutable policy and captured Core ownership", async () => {
  await coreFixture(async ({ dir, ctx, requests, entry }: any) => {
    const sessionPath = join(dir, "resume.jsonl");
    writeFileSync(sessionPath, [
      { type: "session", id: "old-session", cwd: dir },
      { type: "custom", customType: "pi-interactive-subagents.resume-policy", data: {
        version: 2, sessionId: "old-session", agent: null, deniedTools: ["bash"], cwd: dir,
        agentDir: process.env.PI_CODING_AGENT_DIR, systemPrompt: null, requestedSkills: [], activeTools: ["read"], skills: [],
      } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    const tools: any[] = [];
    const handlers = new Map<string, any>();
    subagentsExtension({
      events: { emit() {}, on() { return () => {}; } }, on(name: string, handler: any) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
      sendMessage() {}, getAllTools() { return []; },
    } as any);
    try {
      const result = await tools.find(tool => tool.name === "subagent_resume").execute("test", { sessionPath, name: "Resume task", message: "Continue once", autoExit: true }, undefined, undefined, ctx);
      assert.equal(result.details.status, "started");
      const launch = requests.find((request: any) => request.method === "terminal.run").params;
      const script = readFileSync(launch.argv[1], "utf8");
      assert.ok(script.includes(entry));
      assert.match(script, /PI_SUBAGENT_RESTORE_POLICY=1/);
      assert.match(script, /PI_DENY_TOOLS='bash'/);
      assert.match(script, /--tools 'read'/);
      assert.match(script, /PI_SUBAGENT_SURFACE="\$HC_TERMINAL_ID"/);
      const running = [...__test__.runningSubagents.values()][0];
      assert.equal(running.coreHost.address, "t2");
      // A stale/new global selector must not reroute controls away from the captured Core.
      process.env.PI_SUBAGENT_MUX = "zellij";
      const interrupted = await tools.find(tool => tool.name === "subagent_interrupt").execute("escape", { id: running.id }, undefined, undefined, ctx);
      assert.equal(interrupted.details.status, "interrupt_requested");
      assert.equal(requests.filter((request: any) => request.method === "terminal.keys").length, 1);
    } finally {
      await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });
});

it("launches Pi through Core once with a prepared wrapper and app-adopted named tab", async () => {
  await coreFixture(async ({ ctx, requests, entry, appLog }: any) => {
    const running = await __test__.launchSubagent({ name: "Review\u001b[31m task", task: "Inspect exactly once", tools: "read", interactive: true }, ctx);
    const launches = requests.filter((request: any) => request.method === "terminal.run");
    assert.equal(launches.length, 1);
    const launch = launches[0].params;
    assert.equal(running.coreHost.address, "t2");
    assert.deepEqual(running.coreHost.runtime, { node: process.execPath, script: entry, version: "fixture" });
    assert.equal(running.surface, "t2");
    assert.deepEqual(launch.labels, { "herdr.space": "space-test", "pi.subagent.run": running.runId });
    assert.equal(launch.env.PI_SUBAGENT_MUX, "herdr-core");
    assert.equal(launch.env.HERDR_SOCKET_PATH, "");
    assert.equal(launch.env.PI_SUBAGENT_ID, "");
    assert.equal(launch.env.HC_TERMINAL_ID, undefined);
    assert.equal(launch.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
    const script = readFileSync(launch.argv[1], "utf8");
    assert.ok(script.includes(entry));
    assert.ok(script.includes(process.execPath));
    assert.match(script, /PI_SUBAGENT_SURFACE="\$HC_TERMINAL_ID"/);
    assert.ok(script.includes(running.wrapperExitFile));
    assert.ok(script.includes(running.coreHost.wrapperStartFile));
    assert.equal((script.match(/Inspect exactly once/g) ?? []).length, 0, "blank-session task must be artifact-backed");
    const appCalls = readFileSync(appLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(appCalls.every(call => call.home === process.env.HERDR_APP_HOME));
    assert.deepEqual(appCalls.filter(call => call.args[0] === "do").map(call => call.args.slice(0, 2)), [["do", "tab.rename"]]);
    const rename = appCalls.find(call => call.args[0] === "do");
    assert.deepEqual(JSON.parse(rename.args[2]), { id: "child-tab", name: "Review task" });
    const taskPath = script.match(/'@([^']+)'/)?.[1];
    assert.ok(taskPath);
    assert.equal((readFileSync(taskPath, "utf8").match(/Inspect exactly once/g) ?? []).length, 1);
    assert.equal(launch.env.PATH, process.env.PATH);
    assert.equal(launch.env.HERDR_APP_HOME, process.env.HERDR_APP_HOME);
  });
});

it("preserves classic detection precedence despite stale HC indicators", async () => {
  await coreFixture(async ({ dir }: any) => {
    writeFileSync(join(dir, "bin", "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    delete process.env.PI_SUBAGENT_MUX;
    process.env.HERDR_SOCKET_PATH = "/stale-classic.sock";
    process.env.HC_TERMINAL_SOCKET = "/stale-core.sock";
    assert.equal(getMuxBackend(), "herdr");
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    delete process.env.HC_TERMINAL_ID;
    assert.equal(getMuxBackend(), null, "explicit Core must not fall back to classic");
  });
});

it("observes eventual app adoption without creating a replacement terminal", async () => {
  await coreFixture(async ({ ctx, stateFile, requests, appLog }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptPending: 2 }));
    const running = await __test__.launchSubagent({ name: "Delayed task", task: "inspect", tools: "read" }, ctx);
    assert.equal(running.surface, "t2");
    assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
    const calls = readFileSync(appLog, "utf8").trim().split("\n").map(line => JSON.parse(line).args);
    assert.ok(calls.filter(args => args[0] === "ls").length >= 5);
    assert.equal(requests.some((request: any) => request.method === "terminal.keys"), false, "Core startup must not send a command into a shell");
  });
});

it("preserves fork seeding and passes exactly one direct initial task on Core", async () => {
  await coreFixture(async ({ ctx }: any) => {
    const running = await __test__.launchSubagent({ name: "Fork", task: "One fork task", tools: "read", fork: true }, ctx);
    const script = readFileSync(running.launchScriptFile!, "utf8");
    assert.equal((script.match(/One fork task/g) ?? []).length, 1);
    assert.ok(readFileSync(running.sessionFile, "utf8").includes('"type":"session"'));
    assert.ok(running.transcriptStartLine > 0);
  });
});

it("rejects an unsupported parent runtime before Core or app mutation", async () => {
  await coreFixture(async ({ dir, ctx, requests }: any) => {
    process.argv[1] = join(dir, "unrelated.js");
    writeFileSync(process.argv[1], "// not Pi\n");
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect" }, ctx), /identifiable Node-hosted Pi/);
    assert.equal(requests.length, 0);
  });
});

it("rejects a mismapped app parent before terminal.run", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ badParent: true }));
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect" }, ctx), /parent address/);
    assert.equal(requests.some((request: any) => request.method === "terminal.run"), false);
  });
});

it("cleans only its owned child when app rename setup fails", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ renameFails: true }));
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect" }, ctx), /visibility setup failed/);
    assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
    const cleanup = requests.filter((request: any) => ["terminal.kill", "terminal.rm"].includes(request.method));
    assert.deepEqual(cleanup.map((request: any) => [request.method, request.params.terminal]), [["terminal.kill", "t2"], ["terminal.rm", "t2"]]);
  });
});

it("waits for the original wrapper and removes once after an accepted kill", async () => {
  await coreFixture(async ({ ctx, requests }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
    const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 999999, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
    recorder.record({ kind: "agent-ended" });
    writeFileSync(running.coreHost!.wrapperStartFile, JSON.stringify({ version: 1, runId: running.runId, wrapperPid: 456, address: "t2", observedAt: new Date().toISOString() }));
    let completed = false;
    const watcherAbort = new AbortController();
    const watcher = __test__.watchSubagent(running, watcherAbort.signal, { visibleInterval: 5, processProbe(pid: number) {
      if (pid === 999999) throw Object.assign(new Error("Pi disappeared"), { code: "ESRCH" });
    } }).then(result => { completed = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(completed, false, "Pi disappearance is not wrapper completion");
      const termination = await __test__.handleSubagentTerminate({ id: running.id });
      assert.equal(termination.details.status, "termination_requested_unconfirmed");
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 0);
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(completed, false, "native terminal state cannot complete a still-running original wrapper writer");
      writeFileSync(running.wrapperExitFile!, JSON.stringify({ version: 1, runId: running.runId, sourceId: `wrapper:${running.runId}`, sequence: 1, observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 143 } }));
      const result = await watcher;
      assert.equal(result.error, "terminated");
      assert.notEqual(result.exitCode, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(__test__.runningSubagents.has(running.id), false);
    } finally {
      watcherAbort.abort("test cleanup");
      await watcher;
      __test__.releaseRunningSubagent(running.id);
    }
  });
});

it("retains captured ownership and a private recovery descriptor when shutdown removal fails", async () => {
  await coreFixture(async ({ ctx, stateFile }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    writeFileSync(stateFile, JSON.stringify({ ...state, rmFails: true }));
    try {
      const failures = await __test__.shutdownOwnedSubagents("quit");
      assert.equal(failures.length, 1);
      assert.equal(__test__.runningSubagents.get(running.id)?.coreHost?.address, "t2");
      assert.ok(running.artifactDir, "owned Core launches must retain their artifact directory");
      const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(record.runId, running.runId);
      assert.equal(record.endpoint, running.coreHost!.endpoint);
      assert.equal(record.address, "t2");
      assert.equal(record.wrapperPid, 456);
      assert.equal(record.stage, "remove");
      assert.equal(record.script, running.launchScriptFile);
      assert.equal(record.session, running.sessionFile);
      assert.ok(statSync(file).size <= 64 * 1024);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.ok(failures[0].includes(file));
    } finally { __test__.releaseRunningSubagent(running.id); }
  });
});

for (const confirmed of [true, false]) {
  it(`delivers original Core output with ${confirmed ? "confirmed success" : "unknown exit, never success"}`, async () => {
    await coreFixture(async ({ ctx, requests }: any) => {
      const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
      __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
      mkdirSync(dirname(running.sessionFile), { recursive: true });
      writeFileSync(running.sessionFile, [
        { type: "session", id: running.id },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Original findings" }] } },
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
      const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 999999, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
      recorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
      recorder.record({ kind: "agent-settled" });
      writeFileSync(running.coreHost!.wrapperStartFile, JSON.stringify({ version: 1, runId: running.runId, wrapperPid: 456, address: "t2", observedAt: new Date().toISOString() }));
      if (confirmed) writeFileSync(running.wrapperExitFile!, JSON.stringify({ version: 1, runId: running.runId, sourceId: `wrapper:${running.runId}`, sequence: 1, observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 0 } }));
      const result = await __test__.watchSubagent(running, new AbortController().signal, { visibleInterval: 5, processProbe() { throw Object.assign(new Error("Original wrapper gone"), { code: "ESRCH" }); } });
      assert.ok(result.summary.includes("Original findings"));
      assert.equal(result.exitCode === 0, confirmed);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(__test__.runningSubagents.has(running.id), false);
    });
  });
}

it("rejects Claude-on-Core before accessing native context", async () => {
  await coreFixture(async ({ dir, ctx, requests }: any) => {
    const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents"); mkdirSync(agents);
    writeFileSync(join(agents, "review.md"), "---\nname: review\ncli: claude\nmodel: sonnet\nauto-exit: true\nspawning: false\nsystem-prompt: append\n---\nReview only.\n");
    await assert.rejects(__test__.launchSubagent({ name: "Review", agent: "review", task: "inspect" }, ctx), /Claude-on-Core/);
    assert.equal(requests.length, 0);
  });
});
