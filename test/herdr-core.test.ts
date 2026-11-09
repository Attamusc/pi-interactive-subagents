import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../pi-extension/subagents/herdr-core.ts";

const methods = ["terminal.run", "terminal.get", "terminal.list", "terminal.read", "terminal.keys", "terminal.kill", "terminal.rm"];
const parent = { address: "t1", state: "live", pid: 123, argv: ["/bin/zsh"], labels: { "herdr.space": "space-test", "herdr.tab": "tab-parent" }, parent: null };

async function fixture(handler: (request: any) => any, run: (endpoint: string, requests: any[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "hc-"));
  const endpoint = join(dir, "api.sock");
  const requests: any[] = [];
  const server = createServer(socket => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer);
      requests.push(request);
      const result = handler(request);
      if (result === undefined) return;
      const reply = JSON.stringify({ jsonrpc: "2.0", id: request.id, ...result }) + "\n";
      socket.write(reply.slice(0, 7));
      queueMicrotask(() => socket.end(reply.slice(7)));
    });
  });
  try {
    server.listen(endpoint);
    await once(server, "listening");
    await run(endpoint, requests);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

function base(request: any) {
  if (request.method === "hello") return { result: { generation: 1, version: "0.1.19", core: { id: "core-test", name: "fixture" }, methods, features: [], framed: false } };
  if (request.method === "terminal.get") return { result: parent };
  throw new Error(`Unexpected Core method: ${request.method}`);
}

it("launches one owned wrapper and keeps Escape, exit evidence and removal separate", async () => {
  let child: any = { address: "t2", state: "live", pid: 456, argv: ["/bin/bash", "/tmp/core-launch.sh"],
    parent: "t1", labels: { "pi.subagent.run": "run-2", "herdr.space": "space-test" } };
  await fixture(request => {
    if (request.method === "hello") return base(request);
    if (request.method === "terminal.run") return { result: child };
    if (request.method === "terminal.get") return { result: request.params.terminal === "t1" ? parent : child };
    if (request.method === "terminal.read") return { result: { text: "partial output", complete: false, why: "working", how: "screen" } };
    if (request.method === "terminal.keys") return { result: { turn: 0, status: "working" } };
    if (request.method === "terminal.kill") { child = { ...child, state: "finished", pid: null, exit_code: 143, signal: null, reason: "killed" }; return { result: child }; }
    if (request.method === "terminal.rm") return { result: { removed: "t2" } };
    throw new Error(`Unexpected method ${request.method}`);
  }, async (endpoint, requests) => {
    const context = await core.resolveCoreContext({ HC_TERMINAL_SOCKET: endpoint, HC_TERMINAL_ID: "t1" });
    const host = await core.startCoreRun(context, { name: "review-run-2", runId: "run-2", scriptPath: "/tmp/core-launch.sh",
      wrapperStartFile: "/tmp/run-2.wrapper-start.json", cwd: "/tmp/repo", env: { PATH: "/custom/bin", HERDR_SOCKET_PATH: "stale", PI_SUBAGENT_ID: "stale" },
      labels: { "herdr.space": "space-test" } });
    assert.equal(host.address, "t2");
    assert.equal(host.wrapperPid, 456);
    assert.equal(host.wrapperStartFile, "/tmp/run-2.wrapper-start.json");
    const launch = requests.find(r => r.method === "terminal.run").params;
    assert.deepEqual(launch.argv, ["/bin/bash", "/tmp/core-launch.sh"]);
    assert.deepEqual({ parent: launch.parent, caller: launch.caller, keep: launch.keep, rm: launch.rm, wait: launch.wait,
      no_notify: launch.no_notify, outlive_parent: launch.outlive_parent },
    { parent: "t1", caller: "t1", keep: true, rm: false, wait: false, no_notify: true, outlive_parent: false });
    assert.equal(launch.env.PATH, "/custom/bin");
    assert.equal(launch.env.PI_SUBAGENT_MUX, "herdr-core");
    assert.equal(launch.env.HERDR_SOCKET_PATH, "");
    assert.equal(launch.env.PI_SUBAGENT_ID, "");
    assert.equal(Object.keys(launch.env).some(k => k.startsWith("HC_")), false);
    assert.deepEqual(await core.readCoreScreen(host), { text: "partial output", complete: false, why: "working" });
    await core.sendCoreEscape(host);
    assert.equal((await core.getCoreTerminal(host)).state, "live");
    assert.deepEqual(requests.find(r => r.method === "terminal.keys").params, { terminal: "t2", keys: ["esc"] });
    assert.equal(requests.some(r => r.method === "terminal.kill"), false);
    assert.equal((await core.killCoreTerminal(host)).state, "finished");
    assert.equal(requests.some(r => r.method === "terminal.rm"), false);
    await core.removeCoreTerminal(host);
    assert.equal(requests.filter(r => r.method === "terminal.run").length, 1);
    assert.deepEqual(requests.find(r => r.method === "terminal.rm").params, { terminal: "t2" });
  });
});

it("does not start a second wrapper when a run acknowledgment is uncorrelated", async () => {
  const child = { address: "t3", state: "live", pid: 789, parent: "t1", argv: ["/bin/bash", "/tmp/reconcile.sh"], labels: { "pi.subagent.run": "recover" } };
  await fixture(request => {
    if (request.method === "terminal.run") return { id: "wrong-id", result: child };
    if (request.method === "terminal.list") return { result: { terminals: [child], hidden_finished: 0 } };
    return base(request);
  }, async (endpoint, requests) => {
    const ctx = await core.resolveCoreContext({ HC_TERMINAL_SOCKET: endpoint, HC_TERMINAL_ID: "t1" });
    const host = await core.startCoreRun(ctx, { name: "recover", runId: "recover", scriptPath: "/tmp/reconcile.sh", wrapperStartFile: "/tmp/recover.json", cwd: "/tmp", env: {}, labels: {} });
    assert.equal(host.address, "t3");
    assert.equal(host.wrapperPid, undefined, "a reconciled record may already contain a recovery shell PID");
    assert.equal(requests.filter(r => r.method === "terminal.run").length, 1);
    assert.deepEqual(requests.find(r => r.method === "terminal.list").params, { all: true, labels: { "pi.subagent.run": "recover" } });
  });
});

it("retains reconciliation identity instead of claiming an ambiguous launch failed cleanly", async () => {
  await fixture(request => {
    if (request.method === "terminal.run") return { id: "wrong", result: {} };
    if (request.method === "terminal.list") return { result: { terminals: [], hidden_finished: 0 } };
    return base(request);
  }, async (endpoint, requests) => {
    const ctx = await core.resolveCoreContext({ HC_TERMINAL_SOCKET: endpoint, HC_TERMINAL_ID: "t1" });
    await assert.rejects(core.startCoreRun(ctx, { name: "uncertain", runId: "uncertain", scriptPath: "/tmp/uncertain.sh", wrapperStartFile: "/tmp/uncertain.json", cwd: "/tmp", env: {}, labels: {} }),
      (error: any) => error instanceof core.CoreLaunchUnconfirmed && error.context.endpoint === endpoint && error.runId === "uncertain");
    assert.equal(requests.filter(r => r.method === "terminal.run").length, 1);
  });
});

it("rejects unavailable generations/methods and inherited parent identity without mutation", async () => {
  await assert.rejects(core.resolveCoreContext({}), /HC_TERMINAL_SOCKET/);
  for (const change of [{ generation: 2 }, { methods: [] }]) {
    await fixture(request => ({ result: { ...base(request).result, ...change } }), async (endpoint, requests) => {
      await assert.rejects(core.resolveCoreContext({ HC_TERMINAL_SOCKET: endpoint, HC_TERMINAL_ID: "t1" }), /generation 1/);
      assert.deepEqual(requests.map(r => r.method), ["hello"]);
    });
  }
  await fixture(request => request.method === "hello" ? base(request) : { result: { ...parent, state: "finished" } }, async (endpoint, requests) => {
    await assert.rejects(core.resolveCoreContext({ HC_TERMINAL_SOCKET: endpoint, HC_TERMINAL_ID: "t1" }), /not live/);
    assert.equal(requests.some(r => r.method === "terminal.run"), false);
  });
});

it("bounds unanswered requests and preserves structured Core errors", async () => {
  await fixture(() => undefined, async endpoint => {
    await assert.rejects(core.coreRpcCall(endpoint, "hello", {}, 10), (error: any) => error.kind === "timeout");
  });
  await fixture(() => ({ error: { code: -32000, message: "not here", data: { kind: "not_found" } } }), async endpoint => {
    await assert.rejects(core.coreRpcCall(endpoint, "terminal.get", { terminal: "t0" }), (error: any) => error.kind === "not_found");
  });
});

it("rejects forged HC identity and a Core replacement before mutating a terminal", async () => {
  let replacement = false;
  await fixture(request => request.method === "hello" && replacement
    ? { result: { ...base(request).result, core: { id: "other-core", name: "other" } } } : base(request), async (endpoint, requests) => {
    const ctx = await core.resolveCoreContext({ HC_TERMINAL_SOCKET: endpoint, HC_TERMINAL_ID: "t1" });
    await assert.rejects(core.startCoreRun(ctx, { name: "fake", runId: "fake", scriptPath: "/tmp/fake.sh", wrapperStartFile: "/tmp/fake.json", cwd: "/tmp", env: { HC_TERMINAL_ID: "t1" }, labels: {} }), /Core-assigned/);
    replacement = true;
    await assert.rejects(core.sendCoreEscape({ kind: "herdr-core", ...ctx, address: "t2", runId: "x", scriptPath: "/tmp/x.sh", wrapperStartFile: "/tmp/x.json" }), /different Core/);
    assert.equal(requests.some(r => ["terminal.run", "terminal.keys", "terminal.kill"].includes(r.method)), false);
  });
});

it("requires a correlated kill response and a key submission receipt", async () => {
  let invalidKeys = true;
  const child = { ...parent, address: "t2", parent: "t1", labels: { "pi.subagent.run": "x" } };
  await fixture(request => {
    if (request.method === "hello") return base(request);
    if (request.method === "terminal.get") return { result: child };
    if (request.method === "terminal.keys") return { result: invalidKeys ? null : { turn: 1 } };
    if (request.method === "terminal.kill") return { result: { ...child, address: "t4", state: "finished" } };
    throw new Error("unexpected request");
  }, async endpoint => {
    const host: core.CoreHostRef = { kind: "herdr-core", endpoint, parent: "t1", coreId: "core-test", address: "t2", runId: "x", scriptPath: "/tmp/x.sh", wrapperStartFile: "/tmp/x.json" };
    await assert.rejects(core.sendCoreEscape(host), /key submission/);
    invalidKeys = false;
    await core.sendCoreEscape(host);
    await assert.rejects(core.killCoreTerminal(host), /owned terminal/);
  });
});

it("rejects oversized replies and changed ownership without issuing destructive operations", async () => {
  await fixture(() => ({ result: "x".repeat(1024 * 1024 + 1) }), async endpoint => {
    await assert.rejects(core.coreRpcCall(endpoint, "hello", {}), (error: any) => error.kind === "invalid_reply");
  });
  await fixture(request => request.method === "hello" ? base(request)
    : { result: { ...parent, address: "t2", parent: "t1", labels: { "pi.subagent.run": "someone-else" } } }, async (endpoint, requests) => {
    const host: core.CoreHostRef = { kind: "herdr-core", endpoint, parent: "t1", coreId: "core-test", address: "t2", runId: "own", scriptPath: "/tmp/own.sh", wrapperStartFile: "/tmp/own.json" };
    await assert.rejects(core.killCoreTerminal(host), (error: any) => error.kind === "owner_mismatch");
    await assert.rejects(core.removeCoreTerminal(host), (error: any) => error.kind === "owner_mismatch");
    assert.equal(requests.some(r => ["terminal.kill", "terminal.rm"].includes(r.method)), false);
  });
});

it("does not remove a live program and accepts only removal of the owned record", async () => {
  let finished = false;
  await fixture(request => {
    if (request.method === "hello") return base(request);
    if (request.method === "terminal.get") return { result: { ...parent, address: "t2", parent: "t1", state: finished ? "finished" : "live", labels: { "pi.subagent.run": "own" } } };
    if (request.method === "terminal.rm") return { result: { removed: "not-the-owned-record" } };
    throw new Error("unexpected method");
  }, async (endpoint, requests) => {
    const host: core.CoreHostRef = { kind: "herdr-core", endpoint, parent: "t1", coreId: "core-test", address: "t2", runId: "own", scriptPath: "/tmp/own.sh", wrapperStartFile: "/tmp/own.json" };
    await assert.rejects(core.removeCoreTerminal(host), (error: any) => error.kind === "live");
    assert.equal(requests.some(r => r.method === "terminal.rm"), false);
    finished = true;
    await assert.rejects(core.removeCoreTerminal(host), /not confirmed/);
  });
});

it("validates the inherited Core endpoint and live parent through the generation-1 interface", async () => {
  await fixture(base, async (endpoint, requests) => {
    const context = await core.resolveCoreContext({ HC_TERMINAL_SOCKET: endpoint, HC_TERMINAL_ID: "t1" });
    assert.equal(context.endpoint, endpoint);
    assert.equal(context.parent, "t1");
    assert.equal(context.coreId, "core-test");
    assert.deepEqual(context.parentTerminal.labels, { "herdr.space": "space-test", "herdr.tab": "tab-parent" });
    assert.deepEqual(requests.map(r => [r.jsonrpc, r.method, r.params]), [
      ["2.0", "hello", { generation: 1 }],
      ["2.0", "terminal.get", { terminal: "t1" }],
    ]);
  });
});
