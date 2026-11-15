import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { waitForVisibleCompletion } from "../pi-extension/subagents/completion-watch.ts";
import { createChildCompletionRecorder } from "../pi-extension/subagents/completion.ts";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { getDirectChildCount } from "../pi-extension/subagents/ownership.ts";
import { pollForExit, getMuxBackend, muxSetupHint } from "../pi-extension/subagents/cmux.ts";
import { prepareCoreLaunch, launchPreparedCoreRun } from "../pi-extension/subagents/core-launch.ts";

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

const block = (id: string, terminal: string) => ({ id, type: "block", content: { terminal } });
const layout = (root: any) => ({ version: 1, value: { spaces: [{ id: "space-test", tabs: [{ id: "parent-tab", root }] }] } });

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
        case "hello": result = { generation: 1, core: { id: JSON.parse(readFileSync(stateFile, "utf8")).coreId ?? "test-core" }, methods: ["doc.get", "terminal.run", "terminal.get", "terminal.list", "terminal.read", "terminal.keys", "terminal.kill", "terminal.rm"] }; break;
        case "doc.get": {
          assert.deepEqual(request.params, { name: "herdr-app" });
          const state = JSON.parse(readFileSync(stateFile, "utf8"));
          const children = [block("parent-pane", state.badParent ? "t9" : "t1")];
          if (state.child && state.childSpace && !(state.adoptPending > 0) && !state.adoptNever) {
            children.push(block(state.adoptionFails ? "parent-pane" : "child-pane", state.childAddress ?? "t2"));
            if (state.duplicateChild) children.push(block("duplicate-pane", "t2"));
            if (state.remoteChild) children.push(block("remote-child-pane", "remote/t2"));
          }
          const document = layout({ type: "row", children: [{ type: "column", children: [{ type: "stack", children }] }] });
          if (state.child && state.wrongTab) document.value.spaces[0].tabs[0].id = "other-tab";
          if (state.child && state.wrongSpace) document.value.spaces[0].id = "other-space";
          result = state.document ?? document;
          if (state.child && state.adoptPending > 0) writeFileSync(stateFile, JSON.stringify({ ...state, adoptPending: state.adoptPending - 1 }));
          break;
        }
        case "terminal.get":
          if (request.params.terminal !== "t1" && JSON.parse(readFileSync(stateFile, "utf8")).missingChild) {
            socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture missing registry record", data: { kind: "not_found" } } }) + "\n"); return;
          }
          result = request.params.terminal === "t1" ? parent : child; break;
        case "terminal.run":
          child = { address: "t2", state: "live", pid: 456, argv: request.params.argv, parent: "t1", labels: request.params.labels };
          const serviceState = JSON.parse(readFileSync(stateFile, "utf8"));
          writeFileSync(stateFile, JSON.stringify({ ...serviceState, child: true, childTab: request.params.labels["herdr.tab"], childSpace: request.params.labels["herdr.space"] }));
          if (JSON.parse(readFileSync(stateFile, "utf8")).unconfirmed) {
            const reply = () => socket.end(JSON.stringify({ jsonrpc: "2.0", id: "uncorrelated", result: child }) + "\n");
            if (JSON.parse(readFileSync(stateFile, "utf8")).delayRunReply) setTimeout(reply, 50); else reply();
            return;
          }
          result = child; break;
        case "terminal.list": {
          const state = JSON.parse(readFileSync(stateFile, "utf8"));
          result = { terminals: state.hideChild || state.hideChildOnce ? [] : state.ambiguous ? [child, { ...child, address: "t3" }] : [child], hidden_finished: 0 };
          if (state.hideChildOnce) writeFileSync(stateFile, JSON.stringify({ ...state, hideChildOnce: false }));
          break;
        }
        case "terminal.kill":
          if (JSON.parse(readFileSync(stateFile, "utf8")).killFails) {
            socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture kill failure", data: { kind: "busy" } } }) + "\n"); return;
          }
          child = { ...child, state: "finished", pid: null, exit_code: 143 }; result = child; break;
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
    writeFileSync(join(bin, "herdr-app"), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(appLog)}, 'forbidden desktop CLI invocation\\n');process.exit(99);\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.HERDR_APP_HOME = join(dir, "selected-app");
    process.env.PI_CODING_AGENT_DIR = join(dir, "profile"); mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    process.env.HC_TERMINAL_ID = "t1";
    process.env.HC_TERMINAL_SOCKET = join(dir, "api.sock");
    const session = join(dir, "parent.jsonl"); writeFileSync(session, JSON.stringify({ type: "session", id: "parent", cwd: dir }) + "\n");
    server.listen(process.env.HC_TERMINAL_SOCKET); await once(server, "listening");
    await run({ dir, entry, requests, parent, appLog, stateFile, ctx: { cwd: dir, sessionManager: { getSessionFile: () => session, getSessionId: () => "parent", getSessionDir: () => dir } } });
    assert.equal(existsSync(appLog), false, "desktop herdr-app CLI is forbidden");
    assert.equal(requests.some(request => request.method === "doc.set"), false);
  } finally {
    process.env = saved; process.argv[1] = originalArgv;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const autoExit of [true, false]) {
  it(`resumes through the registered tool with autoExit=${autoExit} and captured Core ownership`, async () => {
    await coreFixture(async ({ dir, ctx, requests, entry, appLog }: any) => {
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
        const result = await tools.find(tool => tool.name === "subagent_resume").execute("test", { sessionPath, name: "Resume task", message: "Continue once", autoExit }, undefined, undefined, ctx);
        assert.equal(result.details.status, "started");
        const launch = requests.find((request: any) => request.method === "terminal.run").params;
        assert.equal(launch.labels["herdr.space"], autoExit ? undefined : "space-test");
        assert.equal(launch.labels["herdr.tab"], autoExit ? undefined : "parent-tab");
        assert.equal(requests.some((request: any) => request.method === "doc.get"), !autoExit);
        assert.equal(existsSync(appLog), false);
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
}

for (const scenario of [
  { name: "default autonomous", agent: "autonomous", expected: false },
  { name: "explicit true overrides auto-exit", agent: "autonomous", interactive: true, expected: true },
  { name: "explicit false with auto-exit", agent: "autonomous", interactive: false, expected: false },
  { name: "explicit false overrides interactive definition", agent: "interactive", interactive: false, expected: false },
  { name: "explicit false on bare launch", interactive: false, expected: false },
  { name: "nested row without app labels", agent: "autonomous", nested: true, expected: false },
  { name: "unlabeled mobile parent", interactive: true, nested: true, expected: true },
]) {
  it(`presents ${scenario.name} using resolved interactivity`, async () => {
    await coreFixture(async ({ ctx, requests, parent, appLog }: any) => {
      const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents");
      mkdirSync(agents);
      writeFileSync(join(agents, "autonomous.md"), "---\nname: autonomous\nauto-exit: true\n---\nInspect once.\n");
      writeFileSync(join(agents, "interactive.md"), "---\nname: interactive\ninteractive: true\nauto-exit: false\n---\nInspect interactively.\n");
      if (scenario.nested) parent.labels = {};
      const runtime = registeredRuntime(ctx);
      try {
        const result = await runtime.launch({ name: scenario.name, task: "inspect", agent: scenario.agent, interactive: scenario.interactive });
        assert.equal(result.details.status, "started");
        const launch = requests.find((request: any) => request.method === "terminal.run").params;
        assert.equal(launch.parent, "t1");
        assert.equal(launch.caller, "t1");
        assert.match(launch.name, /^[a-z0-9_-]{1,32}$/);
        assert.equal(launch.name, `${scenario.name.replaceAll(" ", "-").slice(0, 23)}-${launch.labels["pi.subagent.run"]}`);
        assert.equal(launch.labels["herdr.space"], scenario.expected ? "space-test" : undefined);
        assert.equal(launch.labels["herdr.tab"], scenario.expected ? "parent-tab" : undefined);
        assert.ok(launch.labels["pi.subagent.run"]);
        assert.equal(launch.env.HERDR_APP_HOME, undefined, "app home is not a Core launch dependency");
        assert.equal(existsSync(appLog), false);
        assert.equal(requests.some((request: any) => request.method === "doc.get"), scenario.expected);
      } finally {
        await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      }
    });
  });
}

it("keeps Core names unique by run for repeated, long and non-ASCII titles", async () => {
  await coreFixture(async ({ dir, requests }: any) => {
    for (const [index, title] of ["Review task", "Review task ".repeat(12), "調査🧪".repeat(30)].entries()) {
      const prepared = await prepareCoreLaunch(title, false);
      const runIds = [`a000000${index}`, `b000000${index}`];
      for (const runId of runIds) {
        await launchPreparedCoreRun(prepared, {
          runId, scriptPath: join(dir, `${runId}.sh`), wrapperStartFile: join(dir, `${runId}.json`),
          command: "true", cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR!,
        });
      }
      const launches = requests.filter((request: any) => request.method === "terminal.run").slice(-2);
      const names = launches.map((request: any) => request.params.name);
      assert.notEqual(names[0], names[1], "same task title must not collide across runs");
      for (const [runIndex, name] of names.entries()) {
        assert.match(name, /^[a-z0-9_-]{1,32}$/);
        assert.ok(name.endsWith(`-${runIds[runIndex]}`), "preserve the complete run suffix");
        assert.ok(name.startsWith(index === 2 ? "pi-subagent-" : "review-task-"));
      }
    }
  });
});

it("launches Pi through Core once with a prepared wrapper and same-tab distinct pane", async () => {
  await coreFixture(async ({ ctx, requests, entry, appLog }: any) => {
    const running = await __test__.launchSubagent({ name: "Review\u001b[31m task", task: "Inspect exactly once", tools: "read", interactive: true }, ctx);
    const launches = requests.filter((request: any) => request.method === "terminal.run");
    assert.equal(launches.length, 1);
    const launch = launches[0].params;
    assert.equal(running.coreHost.address, "t2");
    assert.deepEqual(running.coreHost.runtime, { node: process.execPath, script: entry, version: "fixture" });
    assert.equal(running.surface, "t2");
    assert.deepEqual(launch.labels, { "herdr.space": "space-test", "herdr.tab": "parent-tab", "pi.subagent.run": running.runId });
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
    assert.equal(existsSync(appLog), false);
    assert.ok(requests.filter((request: any) => request.method === "doc.get").length >= 2);
    assert.equal(launch.name, `review-task-${running.runId}`);
    const taskPath = script.match(/'@([^']+)'/)?.[1];
    assert.ok(taskPath);
    assert.equal((readFileSync(taskPath, "utf8").match(/Inspect exactly once/g) ?? []).length, 1);
    assert.equal(launch.env.PATH, process.env.PATH);
    assert.equal(launch.env.HERDR_APP_HOME, undefined);
  });
});

it("prefers Core before classic indicators, fails closed on stale Core, and honors explicit legacy", async () => {
  await coreFixture(async ({ dir, requests }: any) => {
    writeFileSync(join(dir, "bin", "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    delete process.env.PI_SUBAGENT_MUX;
    process.env.HERDR_SOCKET_PATH = "/stale-classic.sock";
    assert.equal(getMuxBackend(), "herdr-core", "valid Core context takes precedence over classic");
    process.env.HC_TERMINAL_SOCKET = join(dir, "stale-core.sock");
    assert.equal(getMuxBackend(), "herdr-core");
    await assert.rejects(prepareCoreLaunch("Stale", true), /Herdr Core hello/);
    assert.equal(requests.some((request: any) => request.method === "terminal.run"), false);
    process.env.PI_SUBAGENT_MUX = "herdr";
    assert.equal(getMuxBackend(), "herdr", "explicit legacy override remains authoritative");
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    delete process.env.HC_TERMINAL_ID;
    assert.equal(getMuxBackend(), null, "explicit Core must not fall back to classic");
  });
});

it("observes eventual client adoption in Core Doc without creating a replacement terminal", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptPending: 2 }));
    const running = await __test__.launchSubagent({ name: "Delayed task", task: "inspect", tools: "read" }, ctx);
    assert.equal(running.surface, "t2");
    assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
    assert.ok(requests.filter((request: any) => request.method === "doc.get").length >= 4);
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

it("rejects a missing Core Doc parent before terminal.run", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ badParent: true }));
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect" }, ctx), /parent.*missing|parent.*ambiguous/);
    assert.equal(requests.some((request: any) => request.method === "terminal.run"), false);
  });
});

for (const [name, document] of [
  ["substring address", layout(block("parent-pane", "t10"))],
  ["remote-qualified parent address", layout(block("parent-pane", "remote/t1"))],
  ["missing mapping", layout({ type: "row", children: [] })],
  ["duplicate terminal", layout({ type: "row", children: [block("one", "t1"), block("two", "t1")] })],
  ["missing pane ID", layout({ type: "block", content: { terminal: "t1" } })],
  ["unknown node", layout({ type: "grid", children: [block("parent-pane", "t1")] })],
  ["malformed children", layout({ type: "stack", children: {} })],
  ["malformed content", layout({ id: "parent-pane", type: "block", content: { terminal: 1 } })],
  ["mixed content", layout({ id: "parent-pane", type: "block", content: { terminal: "t1", mod: "notes" } })],
  ["missing document", { version: 0, value: null }],
  ["invalid version", { ...layout(block("parent-pane", "t1")), version: "1" }],
  ["malformed spaces", { version: 1, value: { spaces: {} } }],
  ["duplicate spaces", { version: 1, value: { spaces: [...layout(block("one", "t1")).value.spaces, ...layout(block("two", "t1")).value.spaces] } }],
  ["duplicate tabs", { version: 1, value: { spaces: [{ id: "space-test", tabs: [{ id: "parent-tab", root: block("one", "t1") }, { id: "parent-tab", root: block("two", "t9") }] }] } }],
  ["cross-space duplicate address", { version: 1, value: { spaces: [...layout(block("one", "t1")).value.spaces, { id: "other-space", tabs: [{ id: "other-tab", root: block("two", "t1") }] }] } }],
  ["cross-space duplicate tab ID", { version: 1, value: { spaces: [...layout(block("one", "t1")).value.spaces, { id: "other-space", tabs: [{ id: "parent-tab", root: block("two", "t9") }] }] } }],
  ["cross-tab duplicate node ID", { version: 1, value: { spaces: [{ id: "space-test", tabs: [{ id: "parent-tab", root: block("shared-node", "t1") }, { id: "other-tab", root: { type: "stack", id: "shared-node", children: [] } }] }] } }],
  ["cross-space duplicate node ID", { version: 1, value: { spaces: [...layout(block("shared-node", "t1")).value.spaces, { id: "other-space", tabs: [{ id: "other-tab", root: block("shared-node", "t9") }] }] } }],
] as const) {
  it(`rejects ${name} in Core Doc before terminal.run`, async () => {
    await coreFixture(async ({ stateFile, requests }: any) => {
      writeFileSync(stateFile, JSON.stringify({ document }));
      await assert.rejects(prepareCoreLaunch("Task", true), /Core.*(layout|parent)/);
      assert.equal(requests.some((request: any) => request.method === "terminal.run"), false);
    });
  });
}

for (const label of ["herdr.space", "herdr.tab"]) {
  it(`cross-checks the optional ${label} parent hint`, async () => {
    await coreFixture(async ({ parent, requests }: any) => {
      parent.labels = { [label]: "wrong" };
      await assert.rejects(prepareCoreLaunch("Task", true), /parent.*label/);
      assert.equal(requests.some((request: any) => request.method === "terminal.run"), false);
    });
  });
  it(`accepts a matching ${label} hint without requiring the other`, async () => {
    await coreFixture(async ({ parent }: any) => {
      parent.labels = { [label]: label === "herdr.space" ? "space-test" : "parent-tab" };
      await prepareCoreLaunch("Task", true);
    });
  });
}

it("ignores nonterminal content and unknown metadata rather than treating embedded addresses as panes", async () => {
  await coreFixture(async ({ stateFile }: any) => {
    writeFileSync(stateFile, JSON.stringify({ document: layout({ type: "row", metadata: block("fake", "t1"), children: [
      block("parent-pane", "t1"), { type: "block", id: "notes", content: { mod: "notes", props: { terminal: "t1" } } },
      { type: "block", id: "agent", content: { agent: "t1" } },
      { type: "block", id: "tab", content: { tab: "t1" } },
    ] }) }));
    await prepareCoreLaunch("Task", true);
  });
});

for (const state of [{ wrongTab: true }, { wrongSpace: true }, { duplicateChild: true }]) {
  it(`cleans owned child on invalid adoption ${JSON.stringify(state)}`, async () => {
    await coreFixture(async ({ stateFile, ctx, requests }: any) => {
      writeFileSync(stateFile, JSON.stringify(state));
      await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect", interactive: true }, ctx), /visibility setup failed/);
      assert.deepEqual(requests.filter((request: any) => ["terminal.kill", "terminal.rm"].includes(request.method)).map((request: any) => [request.method, request.params.terminal]), [["terminal.kill", "t2"], ["terminal.rm", "t2"]]);
    });
  });
}

it("does not confuse a remote-qualified child with the exact local child address", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ remoteChild: true }));
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", interactive: true }, ctx);
    assert.equal(running.surface, "t2", "remote/t2 must not become a second match for t2");
    assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
  });
});

it("times out on a substring-only child address and cleans only its exact owned terminal", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ childAddress: "t20" }));
    const started = Date.now();
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect", interactive: true }, ctx), /adoption timed out/);
    assert.ok(Date.now() - started < 12_000);
    assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
    assert.deepEqual(requests.filter((request: any) => ["terminal.kill", "terminal.rm"].includes(request.method)).map((request: any) => request.params.terminal), ["t2", "t2"]);
  });
});

it("binds document reads and launch to the captured Core identity", async () => {
  await coreFixture(async ({ stateFile, dir, requests }: any) => {
    const prepared = await prepareCoreLaunch("Task", true);
    writeFileSync(stateFile, JSON.stringify({ coreId: "replacement" }));
    await assert.rejects(launchPreparedCoreRun(prepared, { runId: "binding", scriptPath: join(dir, "binding.sh"), wrapperStartFile: join(dir, "binding.json"), command: "true", cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR! }), /different Core/);
    assert.equal(requests.some((request: any) => request.method === "terminal.run"), false);
  });
});

it("autonomous children require neither layout document nor desktop app", async () => {
  await coreFixture(async ({ stateFile, parent, requests }: any) => {
    parent.labels = {};
    writeFileSync(stateFile, JSON.stringify({ document: { invalid: true } }));
    await prepareCoreLaunch("Autonomous", false);
    assert.equal(requests.some((request: any) => request.method === "doc.get"), false);
  });
});

it("cleans only its owned child when client pane adoption fails", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true }));
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

function registeredRuntime(ctx: any) {
  const tools: any[] = [];
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  subagentsExtension({
    events: { emit() {}, on() { return () => {}; } }, on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    sendMessage(message: any) { messages.push(message); }, getAllTools() { return []; },
  } as any);
  handlers.get("session_start")({}, ctx);
  return { tools, handlers, messages, launch: (params: any) => tools.find(tool => tool.name === "subagent").execute("launch", params, undefined, undefined, ctx) };
}

it("retains failed visibility cleanup from the registered tool and retries only removal", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, rmFails: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
      assert.equal(__test__.runningSubagents.size, 1, "failed setup must remain directly owned");
      assert.equal(getDirectChildCount(), 1);
      const running = [...__test__.runningSubagents.values()][0];
      assert.equal(running.coreHost?.address, "t2");
      assert.equal(running.coreCleanupStage, "remove");
      const termination = await runtime.tools.find(tool => tool.name === "subagent_terminate").execute("terminate", { id: running.id }, undefined, undefined, ctx);
      assert.equal(termination.details.status, "termination_requested_unconfirmed");
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1, "an already accepted setup kill must not be repeated by controls");
      writeFileSync(stateFile, JSON.stringify({ child: true, adoptionFails: true, rmFails: false }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 2);
      assert.equal(runtime.messages.length, 0, "a failed launch must not deliver a second completion result");
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("retains an unconfirmed registered launch and reconciles its exact run without relaunching", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChild: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /launch .* is unconfirmed/);
      assert.equal(__test__.runningSubagents.size, 1, "unconfirmed launches remain directly owned");
      assert.equal(getDirectChildCount(), 1);
      const running = [...__test__.runningSubagents.values()][0];
      assert.equal(running.coreHost, undefined);
      assert.equal(running.coreLaunchPending?.context.endpoint, process.env.HC_TERMINAL_SOCKET);
      assert.equal(running.coreLaunchPending?.context.coreId, "test-core");
      assert.equal(running.coreLaunchPending?.context.parent, "t1");
      const launch = requests.find((request: any) => request.method === "terminal.run");
      assert.equal(running.coreLaunchPending?.runId, launch.params.labels["pi.subagent.run"]);
      assert.equal(running.coreLaunchPending?.scriptPath, launch.params.argv[1]);
      assert.ok(running.coreLaunchPending?.wrapperStartFile.endsWith(".wrapper-start.json"));
      writeFileSync(stateFile, JSON.stringify({ child: true, unconfirmed: true, hideChild: false }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.deepEqual(requests.filter((request: any) => ["terminal.kill", "terminal.rm"].includes(request.method)).map((request: any) => request.params.terminal), ["t2", "t2"]);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("preserves ambiguous launch ownership and full correlation in a private shutdown descriptor", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChild: true }));
    const runtime = registeredRuntime(ctx);
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = message => { stderr.push(String(message)); };
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /is unconfirmed/);
      assert.equal(__test__.runningSubagents.size, 1);
      const running = [...__test__.runningSubagents.values()][0];
      const interrupt = await runtime.tools.find(tool => tool.name === "subagent_interrupt").execute("escape", { id: running.id }, undefined, undefined, ctx);
      assert.equal(interrupt.details.error, "launch-unconfirmed");
      const terminate = await runtime.tools.find(tool => tool.name === "subagent_terminate").execute("terminate", { id: running.id }, undefined, undefined, ctx);
      assert.equal(terminate.details.error, "launch-unconfirmed");
      writeFileSync(stateFile, JSON.stringify({ child: true, ambiguous: true }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 1);
      const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(record.runId, running.runId);
      assert.equal(record.endpoint, running.coreLaunchPending!.context.endpoint);
      assert.equal(record.coreId, "test-core");
      assert.equal(record.parent, "t1");
      assert.equal(record.script, running.coreLaunchPending!.scriptPath);
      assert.equal(record.wrapperStartFile, running.coreLaunchPending!.wrapperStartFile);
      assert.equal(record.session, running.sessionFile);
      assert.equal(record.address, undefined, "ambiguous addresses must not become owned addresses");
      assert.equal(record.wrapperPid, undefined, "current/recovery PID must not become original identity");
      assert.equal(record.stage, "reconcile");
      assert.ok(statSync(file).size <= 64 * 1024);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(stderr.filter(message => message.includes(file)).length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.some((request: any) => ["terminal.kill", "terminal.rm", "terminal.keys"].includes(request.method)), false);
      assert.equal(runtime.messages.length, 0);
    } finally {
      console.error = originalError;
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(check(), "bounded fake cleanup observation timed out");
}

it("cleans a retained setup once when an actual module reload aborts the old runtime", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, rmFails: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
      assert.equal(__test__.runningSubagents.size, 1);
      writeFileSync(stateFile, JSON.stringify({ child: true, rmFails: false }));
      const replacement = await import("../pi-extension/subagents/index.ts?retained-core-reload");
      await waitUntil(() => __test__.runningSubagents.size === 0);
      assert.equal(replacement.__test__.runningSubagents.size, 0);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 2);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("cleans an unconfirmed in-flight setup that settles after the shutdown snapshot", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChildOnce: true, delayRunReply: true }));
    const runtime = registeredRuntime(ctx);
    try {
      const rejected = assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /is unconfirmed/);
      await waitUntil(() => requests.some((request: any) => request.method === "terminal.run"));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      runtime.handlers.get("session_start")({}, ctx);
      await rejected;
      await waitUntil(() => requests.some((request: any) => request.method === "terminal.rm") && __test__.runningSubagents.size === 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

for (const stage of ["kill", "remove"] as const) {
  it(`describes pre-registration visibility ${stage} failure with its known original identity`, async () => {
    await coreFixture(async ({ ctx, stateFile }: any) => {
      writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, killFails: stage === "kill", rmFails: stage === "remove" }));
      const runtime = registeredRuntime(ctx);
      const stderr: string[] = [];
      const originalError = console.error;
      console.error = message => { stderr.push(String(message)); };
      try {
        await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
        assert.equal(getDirectChildCount(), 1);
        const running = [...__test__.runningSubagents.values()][0];
        const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 789, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
        recorder.record({ kind: "agent-ended" });
        await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
        const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
        const record = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(record.address, "t2");
        assert.equal(record.coreId, "test-core");
        assert.equal(record.parent, "t1");
        assert.equal(record.endpoint, running.coreHost!.endpoint);
        assert.equal(record.wrapperPid, 456);
        assert.equal(record.childPid, 789);
        assert.equal(record.script, running.launchScriptFile);
        assert.equal(record.wrapperStartFile, running.coreHost!.wrapperStartFile);
        assert.equal(record.stage, stage);
        assert.equal(__test__.runningSubagents.size, 1);
        assert.equal(stderr.filter(message => message.includes(file)).length, 1);
        assert.equal(runtime.messages.length, 0);
      } finally {
        console.error = originalError;
        for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
        await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      }
    });
  });
}

it("retains failed registered resume setup under the resumed session identity", async () => {
  await coreFixture(async ({ dir, ctx, stateFile, requests }: any) => {
    const sessionPath = join(dir, "resume-failed.jsonl");
    writeFileSync(sessionPath, [
      { type: "session", id: "old-session", cwd: dir },
      { type: "custom", customType: "pi-interactive-subagents.resume-policy", data: {
        version: 2, sessionId: "old-session", agent: null, deniedTools: ["bash"], cwd: dir,
        agentDir: process.env.PI_CODING_AGENT_DIR, systemPrompt: null, requestedSkills: [], activeTools: ["read"], skills: [],
      } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChild: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.tools.find(tool => tool.name === "subagent_resume").execute("resume", { sessionPath, name: "Resume failed", message: "Continue once" }, undefined, undefined, ctx), /is unconfirmed/);
      assert.equal(getDirectChildCount(), 1);
      const running = [...__test__.runningSubagents.values()][0];
      assert.equal(running.sessionFile, sessionPath);
      assert.equal(running.task, "Continue once");
      writeFileSync(stateFile, JSON.stringify({ child: true, hideChild: false }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("preserves failed reload cleanup in a recovery descriptor without a completion delivery", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, rmFails: true }));
    const runtime = registeredRuntime(ctx);
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = message => { stderr.push(String(message)); };
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
      const running = [...__test__.runningSubagents.values()][0];
      const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
      await import("../pi-extension/subagents/index.ts?retained-core-reload-failure");
      await waitUntil(() => stderr.some(message => message.includes(file)));
      const record = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(record.address, "t2");
      assert.equal(record.coreId, "test-core");
      assert.equal(record.parent, "t1");
      assert.equal(record.runId, running.runId);
      assert.equal(record.stage, "remove");
      assert.equal(__test__.runningSubagents.size, 1);
      assert.equal(stderr.filter(message => message.includes(file)).length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 2);
      assert.equal(runtime.messages.length, 0);
    } finally {
      console.error = originalError;
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("does not infer original process exit from a missing Core registry record with unknown startup identity", async () => {
  await coreFixture(async ({ ctx, stateFile }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    writeFileSync(stateFile, JSON.stringify({ child: true, missingChild: true }));
    const abort = new AbortController();
    let completed = false;
    let ticks = 0;
    const waiting = waitForVisibleCompletion({
      state: running.completionState!, childSnapshotFile: running.childSnapshotFile!, wrapperExitFile: running.wrapperExitFile!,
      sessionFile: running.sessionFile, transcriptStartLine: 0, signal: abort.signal, coreHost: running.coreHost,
      interval: 5, processProbe() { throw Object.assign(new Error("unknown PID"), { code: "ESRCH" }); }, onTick() { ticks++; },
    }).then(result => { completed = true; return result; });
    try {
      await waitUntil(() => completed || ticks > 0);
      assert.equal(completed, false, "registry absence alone is not original process-exit evidence");
      assert.notEqual(running.completionState!.core.process.status, "exited");
    } finally { abort.abort("test cleanup"); await waiting.catch(() => {}); }
  });
});

it("keeps wrapper loss unconfirmed while known Pi lives and rereads final sidecars after proof", async () => {
  await coreFixture(async ({ ctx }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 789, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
    recorder.record({ kind: "agent-ended" });
    writeFileSync(running.coreHost!.wrapperStartFile, JSON.stringify({ version: 1, runId: running.runId, wrapperPid: 456, address: "t2", observedAt: new Date().toISOString() }));
    mkdirSync(dirname(running.sessionFile), { recursive: true });
    writeFileSync(running.sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Original output" }] } }) + "\n");
    const abort = new AbortController();
    let completed = false;
    let piAlive = true;
    let ticks = 0;
    const probed: number[] = [];
    const waiting = waitForVisibleCompletion({
      state: running.completionState!, childSnapshotFile: running.childSnapshotFile!, wrapperExitFile: running.wrapperExitFile!,
      sessionFile: running.sessionFile, transcriptStartLine: 0, signal: abort.signal, coreHost: running.coreHost,
      interval: 5, onTick() { ticks++; }, processProbe(pid: number) {
        probed.push(pid);
        if (pid === 789 && piAlive) return;
        if (pid === 789) writeFileSync(running.wrapperExitFile!, JSON.stringify({ version: 1, runId: running.runId, sourceId: `wrapper:${running.runId}`, sequence: 1, observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 7 } }));
        throw Object.assign(new Error("original process gone"), { code: "ESRCH" });
      },
    }).then(result => { completed = true; return result; });
    try {
      await waitUntil(() => completed || ticks > 0);
      assert.equal(completed, false, "wrapper absence must not imply exit of a known live original Pi");
      assert.ok(probed.includes(789));
      assert.notEqual(running.completionState!.core.process.status, "exited");
      piAlive = false;
      await waitUntil(() => completed);
      const result = await waiting;
      assert.deepEqual(result.completion.processExit, { kind: "shell", shellStatus: 7 }, "final sidecar must beat the first-exit-wins absence fallback");
      assert.equal(result.completion.output, "Original output");
    } finally { abort.abort("test cleanup"); await waiting.catch(() => {}); }
  });
});

it("captures parent PATH and propagates the selected profile without app-home scaffolding", async () => {
  await coreFixture(async ({ dir, requests }: any) => {
    const path = process.env.PATH;
    const profile = process.env.PI_CODING_AGENT_DIR!;
    const prepared = await prepareCoreLaunch("Task", true);
    process.env.PATH = "/unrelated-server-path";
    process.env.PI_CODING_AGENT_DIR = join(dir, "other-profile");
    await launchPreparedCoreRun(prepared, { runId: "profile", scriptPath: join(dir, "profile.sh"),
      wrapperStartFile: join(dir, "profile.json"), command: "true", cwd: dir, agentDir: profile });
    const launch = requests.find((request: any) => request.method === "terminal.run").params;
    assert.equal(launch.env.PATH, path);
    assert.equal(launch.env.PI_CODING_AGENT_DIR, profile);
    assert.equal(launch.env.HERDR_APP_HOME, undefined);
  });
});

for (const scenario of ["success", "nonzero", "cancel", "timeout", "cleanup-failure", "missing-wrapper"] as const) {
  it(`observes Core Claude ${scenario} without classic cleanup`, async () => {
    await coreFixture(async ({ ctx, requests, stateFile }: any) => {
      const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents"); mkdirSync(agents);
      writeFileSync(join(agents, "review.md"), "---\nname: review\ncli: claude\nmodel: sonnet\nauto-exit: true\nspawning: false\nsystem-prompt: append\n---\nReview only.\n");
      const running = await __test__.launchSubagent({ name: "Review", agent: "review", task: "inspect" }, ctx);
      const uuid = "12345678-1234-4234-8234-123456789abc";
      writeFileSync(running.claudeResultFile!, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "review output", session_id: uuid }));
      if (["success", "nonzero", "cleanup-failure"].includes(scenario)) {
        writeFileSync(running.wrapperExitFile!, JSON.stringify({ version: 1, runId: running.runId, sourceId: `wrapper:${running.runId}`, sequence: 1, observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: scenario === "nonzero" ? 7 : 0 } }));
      } else {
        writeFileSync(running.claudeProcessIdFile!, `${running.runId} 4321\n`);
      }
      if (scenario === "missing-wrapper") {
        writeFileSync(join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`), JSON.stringify({ runId: running.runId, stage: "remove" }));
      }
      if (scenario === "cleanup-failure") writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), rmFails: true }));
      __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
      process.env.PI_SUBAGENT_MUX = "zellij";
      const controller = new AbortController();
      if (scenario === "cancel") controller.abort("cancelled");
      try {
        const result = await __test__.watchSubagent(running, controller.signal, {
          visibleInterval: 1,
          closeSurface: async () => { throw Error("classic cleanup forbidden"); },
          processProbe: () => { throw Object.assign(Error("gone"), { code: "ESRCH" }); },
          ...(["timeout", "missing-wrapper"].includes(scenario) ? { pollForExit: async (surface: string, signal: AbortSignal, options: any) => pollForExit(surface, signal, { ...options, timeoutMs: 0 }) } : {}),
        });
        assert.equal(result.exitCode, ["success", "cleanup-failure"].includes(scenario) ? 0 : scenario === "nonzero" ? 7 : 1);
        if (result.exitCode === 0) assert.equal(result.claudeSessionId, uuid);
        else assert.match(result.summary, /review output/);
        if (scenario === "timeout" || scenario === "missing-wrapper") assert.match(result.summary, /deadline exceeded/);
        assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
        assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
        assert.equal(__test__.runningSubagents.has(running.id), scenario === "cleanup-failure");
        if (scenario === "cleanup-failure") {
          writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), rmFails: false }));
          assert.deepEqual(await __test__.shutdownOwnedSubagents("retry"), []);
          assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
          assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 2);
        }
      } finally { __test__.releaseRunningSubagent(running.id); }
    });
  });
}

it("launches read-only Claude through Core once with captured ownership", async () => {
  await coreFixture(async ({ dir, ctx, requests, appLog }: any) => {
    const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents"); mkdirSync(agents);
    writeFileSync(join(agents, "review.md"), "---\nname: review\ncli: claude\nmodel: sonnet\nauto-exit: true\nspawning: false\nsystem-prompt: append\n---\nReview only.\n");
    const running = await __test__.launchSubagent({ name: "Review", agent: "review", task: "inspect", resumeSessionId: "12345678-1234-4234-8234-123456789abc" }, ctx);
    const launches = requests.filter((request: any) => request.method === "terminal.run");
    assert.equal(launches.length, 1);
    assert.equal(running.coreHost?.address, "t2");
    assert.equal(running.coreHost?.parent, "t1");
    assert.equal(running.cli, "claude");
    assert.equal(existsSync(appLog), false);
    const script = readFileSync(running.launchScriptFile!, "utf8");
    assert.ok(script.includes(process.execPath));
    assert.match(script, /--safe-mode --restricted --strict-mcp-config/);
    assert.match(script, /--permission-mode dontAsk --tools 'Read,Glob,Grep'/);
    assert.match(script, /--resume '12345678-1234-4234-8234-123456789abc'/);
    assert.doesNotMatch(script, /--max-turns/);
    assert.ok(script.includes(running.runId));
    assert.ok(script.includes(running.coreHost!.wrapperStartFile));
    __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
    process.env.PI_SUBAGENT_MUX = "zellij";
    try {
      const failures = await __test__.shutdownOwnedSubagents("test", async () => { throw Error("classic close forbidden"); });
      assert.deepEqual(failures, []);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
    } finally { __test__.releaseRunningSubagent(running.id); }

  });
});
