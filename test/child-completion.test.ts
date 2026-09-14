import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { readChildCompletionSnapshot } from "../pi-extension/subagents/completion.ts";
import { setDirectChildCountProvider } from "../pi-extension/subagents/ownership.ts";
import { RESUME_POLICY_CUSTOM_TYPE, RESUME_POLICY_ENV } from "../pi-extension/subagents/resume-policy.ts";

function createHarness(options: { autoExit?: boolean; launchPolicy?: object } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "child-completion-"));
  const runId = "test-run";
  const snapshotFile = join(dir, "completion.json");
  const sessionFile = join(dir, "session.jsonl");
  const previous = { ...process.env };
  process.env.PI_SUBAGENT_ID = runId;
  process.env.PI_SUBAGENT_COMPLETION_FILE = snapshotFile;
  process.env.PI_SUBAGENT_ACTIVITY_FILE = join(dir, "activity.json");
  process.env.PI_SUBAGENT_SESSION = sessionFile;
  process.env.PI_SUBAGENT_NAME = "subagent";
  process.env.PI_SUBAGENT_AUTO_EXIT = options.autoExit ? "1" : "0";
  if (options.launchPolicy) process.env[RESUME_POLICY_ENV] = JSON.stringify(options.launchPolicy);
  else delete process.env[RESUME_POLICY_ENV];

  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  subagentDoneExtension({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerShortcut() {},
    getAllTools() { return [{ name: "read" }, { name: "subagent_done" }]; },
    getActiveTools() { return ["read", "subagent_done"]; },
    appendEntry(customType: string, data: unknown) { customEntries.push({ customType, data }); },
  } as any);
  let shutdowns = 0;
  const ctx = {
    shutdown() { shutdowns++; },
    ui: { setWidget() {} },
    sessionManager: { getSessionId() { return "session-1"; } },
  };
  return {
    handlers, tools, ctx, customEntries, snapshotFile, sessionFile,
    shutdowns: () => shutdowns,
    snapshot() {
      const result = readChildCompletionSnapshot(snapshotFile, runId);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error(result.reason);
      return result.value;
    },
    cleanup() {
      try {
        handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
      } finally {
        process.env = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function execute(tool: any, params: object, ctx: object) {
  return tool.execute("call", params, undefined, undefined, ctx);
}

function assistant(stopReason: string, errorMessage?: string) {
  return [{ role: "assistant", stopReason, ...(errorMessage ? { errorMessage } : {}) }];
}

describe("child completion lifecycle hooks", { concurrency: 1 }, () => {
  it("does not write to an inherited worker activity file", () => {
    const ambientDir = mkdtempSync(join(tmpdir(), "ambient-worker-"));
    const ambientFile = join(ambientDir, "activity.json");
    const originalActivityFile = process.env.PI_SUBAGENT_ACTIVITY_FILE;
    const sentinel = '{"owner":"real-worker"}';
    writeFileSync(ambientFile, sentinel);
    process.env.PI_SUBAGENT_ACTIVITY_FILE = ambientFile;
    const h = createHarness();
    try {
      h.handlers.get("agent_start")!({}, h.ctx);
      assert.equal(readFileSync(ambientFile, "utf8"), sentinel);
    } finally {
      h.handlers.get("session_shutdown")!({ reason: "quit" }, h.ctx);
      h.cleanup();
      if (originalActivityFile === undefined) delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
      else process.env.PI_SUBAGENT_ACTIVITY_FILE = originalActivityFile;
      rmSync(ambientDir, { recursive: true, force: true });
    }
  });
  it("persists the original launch policy with the child's actual active tools", () => {
    const h = createHarness({
      launchPolicy: {
        version: 2,
        agent: "worker",
        deniedTools: ["subagent"],
        cwd: "/work/project",
        agentDir: "/work/agent",
        systemPrompt: { mode: "append", text: "Worker role" },
        requestedSkills: [],
      },
    });
    try {
      h.handlers.get("session_start")!({}, h.ctx);
      h.handlers.get("session_start")!({}, h.ctx);
      assert.deepEqual(h.customEntries, [{
        customType: RESUME_POLICY_CUSTOM_TYPE,
        data: {
          version: 2,
          agent: "worker",
          deniedTools: ["subagent"],
          cwd: "/work/project",
          agentDir: "/work/agent",
          systemPrompt: { mode: "append", text: "Worker role" },
          requestedSkills: [],
          sessionId: "session-1",
          activeTools: ["read", "subagent_done"],
          skills: [],
        },
      }]);
    } finally { h.cleanup(); }
  });

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

  it("defers autonomous shutdown while the process owns a direct child", () => {
    setDirectChildCountProvider(() => 1);
    const h = createHarness({ autoExit: true });
    try {
      h.handlers.get("agent_end")!({ messages: assistant("stop") }, h.ctx);
      h.handlers.get("agent_settled")!({}, h.ctx);
      assert.equal(h.shutdowns(), 0);
      assert.equal(h.snapshot().completionPayload, undefined);
    } finally {
      h.cleanup();
      setDirectChildCountProvider(null);
    }
  });

  it("rejects explicit completion and ping while the process owns a direct child", async () => {
    setDirectChildCountProvider(() => 2);
    const h = createHarness({ autoExit: true });
    try {
      for (const [name, params] of [["subagent_done", {}], ["caller_ping", { message: "help" }]] as const) {
        const result = await execute(h.tools.get(name), params, h.ctx);
        assert.equal(result.details.error, "owned-subagents-active");
        assert.equal(result.details.count, 2);
        assert.match(result.content[0].text, /2 directly owned subagents/);
      }
      assert.equal(h.shutdowns(), 0);
      assert.equal(existsSync(h.snapshotFile), false);
    } finally {
      h.cleanup();
      setDirectChildCountProvider(null);
    }
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
