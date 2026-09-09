import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { readChildCompletionSnapshot } from "../pi-extension/subagents/completion.ts";

function createHarness(options: { autoExit?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "child-completion-"));
  const runId = "test-run";
  const snapshotFile = join(dir, "completion.json");
  const sessionFile = join(dir, "session.jsonl");
  const previous = { ...process.env };
  process.env.PI_SUBAGENT_ID = runId;
  process.env.PI_SUBAGENT_COMPLETION_FILE = snapshotFile;
  process.env.PI_SUBAGENT_SESSION = sessionFile;
  process.env.PI_SUBAGENT_NAME = "subagent";
  process.env.PI_SUBAGENT_AUTO_EXIT = options.autoExit ? "1" : "0";

  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  subagentDoneExtension({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerShortcut() {},
    getAllTools() { return []; },
  } as any);
  let shutdowns = 0;
  const ctx = { shutdown() { shutdowns++; }, ui: { setWidget() {} } };
  return {
    handlers, tools, ctx, snapshotFile, sessionFile,
    shutdowns: () => shutdowns,
    snapshot() {
      const result = readChildCompletionSnapshot(snapshotFile, runId);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    },
    cleanup() { process.env = previous; rmSync(dir, { recursive: true, force: true }); },
  };
}

async function execute(tool: any, params: object, ctx: object) {
  return tool.execute("call", params, undefined, undefined, ctx);
}

function assistant(stopReason: string, errorMessage?: string) {
  return [{ role: "assistant", stopReason, ...(errorMessage ? { errorMessage } : {}) }];
}

describe("child completion lifecycle hooks", { concurrency: 1 }, () => {
  it("requires launcher-owned identity, snapshot, and session inputs", () => {
    const previous = { ...process.env };
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_SUBAGENT_COMPLETION_FILE;
    delete process.env.PI_SUBAGENT_SESSION;
    try {
      assert.throws(() => subagentDoneExtension({} as any), /PI_SUBAGENT_ID.*PI_SUBAGENT_COMPLETION_FILE.*PI_SUBAGENT_SESSION/);
    } finally { process.env = previous; }
  });

  it("records done intent before graceful shutdown and never writes a legacy exit file", async () => {
    const h = createHarness();
    try {
      const result = await execute(h.tools.get("subagent_done"), {}, h.ctx);
      assert.deepEqual(h.snapshot().completionPayload, { kind: "done" });
      assert.equal(h.shutdowns(), 1);
      assert.equal(existsSync(`${h.sessionFile}.exit`), false);
      assert.match(result.content[0].text, /Shutting down/);
    } finally { h.cleanup(); }
  });

  it("does not auto-exit at agent_end and exits only after autonomous settlement", () => {
    const h = createHarness({ autoExit: true });
    try {
      h.handlers.get("agent_end")!({ messages: assistant("stop") }, h.ctx);
      assert.equal(h.shutdowns(), 0);
      assert.equal(h.snapshot().latestFacts.at(-1)?.kind, "agent-ended");
      h.handlers.get("agent_settled")!({}, h.ctx);
      assert.equal(h.shutdowns(), 1);
      assert.deepEqual(h.snapshot().completionPayload, { kind: "done" });
    } finally { h.cleanup(); }
  });

  it("leaves interactive and taken-over sessions waiting", () => {
    for (const [autoExit, setup] of [
      [false, (_h: ReturnType<typeof createHarness>) => {}],
      [true, (h: ReturnType<typeof createHarness>) => { h.handlers.get("agent_start")!({}, h.ctx); h.handlers.get("input")!({}, h.ctx); }],
    ] as const) {
      const h = createHarness({ autoExit });
      try {
        setup(h);
        h.handlers.get("agent_end")!({ messages: assistant("stop") }, h.ctx);
        h.handlers.get("agent_settled")!({}, h.ctx);
        assert.equal(h.shutdowns(), 0);
        assert.equal(h.snapshot().completionPayload, undefined);
      } finally { h.cleanup(); }
    }
  });

  it("uses only the final settled turn for errors and leaves aborted turns open", () => {
    const h = createHarness({ autoExit: true });
    try {
      h.handlers.get("agent_end")!({ messages: assistant("error", "temporary") }, h.ctx);
      h.handlers.get("agent_start")!({}, h.ctx);
      h.handlers.get("agent_end")!({ messages: assistant("stop") }, h.ctx);
      h.handlers.get("agent_settled")!({}, h.ctx);
      assert.deepEqual(h.snapshot().completionPayload, { kind: "done" });
    } finally { h.cleanup(); }

    const aborted = createHarness({ autoExit: true });
    try {
      aborted.handlers.get("agent_end")!({ messages: assistant("aborted") }, aborted.ctx);
      aborted.handlers.get("agent_settled")!({}, aborted.ctx);
      assert.equal(aborted.shutdowns(), 0);
      assert.equal(aborted.snapshot().completionPayload, undefined);
    } finally { aborted.cleanup(); }
  });

  it("reports a final exhausted error and preserves ping payload through settlement and shutdown", async () => {
    const failed = createHarness({ autoExit: true });
    try {
      failed.handlers.get("agent_end")!({ messages: assistant("error", "provider exhausted") }, failed.ctx);
      failed.handlers.get("agent_settled")!({}, failed.ctx);
      assert.deepEqual(failed.snapshot().completionPayload, { kind: "error", errorMessage: "provider exhausted", stopReason: "error" });
      assert.equal(failed.shutdowns(), 1);
    } finally { failed.cleanup(); }

    const ping = createHarness({ autoExit: true });
    try {
      await execute(ping.tools.get("caller_ping"), { message: "need input" }, ping.ctx);
      ping.handlers.get("agent_end")!({ messages: assistant("stop") }, ping.ctx);
      ping.handlers.get("agent_settled")!({}, ping.ctx);
      ping.handlers.get("session_shutdown")!({ reason: "quit" }, ping.ctx);
      assert.deepEqual(ping.snapshot().completionPayload, { kind: "ping", name: "subagent", message: "need input" });
      assert.equal(ping.shutdowns(), 1);
      assert.ok(ping.snapshot().latestFacts.some((fact) => fact.kind === "session-shutdown"));
    } finally { ping.cleanup(); }
  });
});
