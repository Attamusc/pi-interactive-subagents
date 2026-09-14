import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { readChildCompletionSnapshot } from "../pi-extension/subagents/completion.ts";
import { setDirectChildCountProvider } from "../pi-extension/subagents/ownership.ts";
import {
  RESUME_POLICY_CUSTOM_TYPE,
  RESUME_POLICY_ENV,
  RESUME_POLICY_RESTORE_ENV,
} from "../pi-extension/subagents/resume-policy.ts";

function createHarness(options: {
  autoExit?: boolean;
  launchPolicy?: object;
  resumePolicy?: object;
  commands?: any[];
} = {}) {
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
  if (options.resumePolicy) {
    process.env[RESUME_POLICY_RESTORE_ENV] = "1";
    writeFileSync(sessionFile, [
      { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/work/project" },
      { type: "custom", id: "policy", parentId: null, timestamp: "2026-01-01T00:00:01Z", customType: RESUME_POLICY_CUSTOM_TYPE, data: options.resumePolicy },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  } else {
    delete process.env[RESUME_POLICY_RESTORE_ENV];
  }

  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  subagentDoneExtension({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerShortcut() {},
    getAllTools() { return [{ name: "read" }, { name: "subagent_done" }]; },
    getActiveTools() { return ["read", "subagent_done"]; },
    getCommands() { return options.commands ?? []; },
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
      assert.deepEqual(h.customEntries, []);
      assert.deepEqual(h.handlers.get("input")!({ text: "TASK" }, h.ctx), { action: "continue" });
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

  it("bootstraps canonical skills and persists their immutable snapshot before the first agent run", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "child-skill-"));
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "---\nname: tdd\ndescription: Test first\n---\n# TDD\n\nRed then green.\n");
    const h = createHarness({
      launchPolicy: {
        version: 2,
        agent: "worker",
        deniedTools: ["subagent"],
        cwd: "/work/project",
        agentDir: "/work/agent",
        systemPrompt: { mode: "append", text: "Worker role" },
        requestedSkills: ["tdd"],
      },
      commands: [{
        name: "skill:tdd",
        source: "skill",
        sourceInfo: {
          path: skillFile,
          source: "local",
          scope: "user",
          origin: "top-level",
          baseDir: skillDir,
        },
      }],
    });
    try {
      h.handlers.get("session_start")!({}, h.ctx);
      const images = [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "AA==" } }];
      const result = h.handlers.get("input")!({ text: "TASK", images }, h.ctx);
      assert.deepEqual(result, {
        action: "transform",
        text: `<skill name="tdd" location="${skillFile}">\nReferences are relative to ${skillDir}.\n\n# TDD\n\nRed then green.\n</skill>\n\nTASK`,
        images,
      });
      assert.deepEqual(h.customEntries[0]?.data, {
        version: 2,
        agent: "worker",
        deniedTools: ["subagent"],
        cwd: "/work/project",
        agentDir: "/work/agent",
        systemPrompt: { mode: "append", text: "Worker role" },
        requestedSkills: ["tdd"],
        sessionId: "session-1",
        activeTools: ["read", "subagent_done"],
        skills: [{
          name: "tdd",
          filePath: skillFile,
          baseDir: skillDir,
          content: "# TDD\n\nRed then green.",
        }],
      });
      h.handlers.get("agent_start")!({}, h.ctx);
      assert.equal(h.handlers.get("input")!({ text: "FOLLOW UP" }, h.ctx), undefined);
      assert.equal(h.customEntries.length, 1);
    } finally {
      h.cleanup();
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  it("replays immutable skill snapshots on the first resumed input", () => {
    const h = createHarness({
      resumePolicy: {
        version: 2,
        agent: "worker",
        deniedTools: ["subagent"],
        cwd: "/work/project",
        agentDir: "/work/agent",
        systemPrompt: null,
        requestedSkills: ["tdd"],
        sessionId: "session-1",
        activeTools: ["read", "subagent_done"],
        skills: [{
          name: "tdd",
          filePath: "/original/tdd/SKILL.md",
          baseDir: "/original/tdd",
          content: "ORIGINAL TDD",
        }],
      },
      commands: [{
        name: "skill:tdd",
        source: "skill",
        sourceInfo: {
          path: "/changed/tdd/SKILL.md",
          source: "local",
          scope: "user",
          origin: "top-level",
          baseDir: "/changed/tdd",
        },
      }],
    });
    try {
      assert.equal(process.env[RESUME_POLICY_RESTORE_ENV], undefined);
      h.handlers.get("session_start")!({}, h.ctx);
      assert.equal(h.customEntries.length, 0);
      assert.deepEqual(h.handlers.get("input")!({ text: "RESUME TASK" }, h.ctx), {
        action: "transform",
        text: '<skill name="tdd" location="/original/tdd/SKILL.md">\nReferences are relative to /original/tdd.\n\nORIGINAL TDD\n</skill>\n\nRESUME TASK',
      });
      assert.equal(h.customEntries.length, 0);
    } finally { h.cleanup(); }
  });

  it("reports invalid resumed policy through structured completion before provider work", () => {
    const h = createHarness({
      resumePolicy: {
        version: 1,
        agent: "worker",
        deniedTools: [],
        cwd: "/work/project",
        agentDir: "/work/agent",
        systemPrompt: null,
        sessionId: "session-1",
        activeTools: ["read"],
      },
    });
    try {
      h.handlers.get("session_start")!({}, h.ctx);
      assert.equal(h.shutdowns(), 1);
      assert.deepEqual(h.snapshot().completionPayload, {
        kind: "error",
        errorMessage: "Unable to restore subagent policy: invalid resume policy: resume policy is missing required fields",
        stopReason: "error",
      });
    } finally { h.cleanup(); }
  });

  it("fails closed before the provider when a requested skill is unavailable", () => {
    const h = createHarness({
      launchPolicy: {
        version: 2,
        agent: "worker",
        deniedTools: ["subagent"],
        cwd: "/work/project",
        agentDir: "/work/agent",
        systemPrompt: null,
        requestedSkills: ["missing"],
      },
    });
    try {
      h.handlers.get("session_start")!({}, h.ctx);
      assert.deepEqual(h.handlers.get("input")!({ text: "TASK" }, h.ctx), { action: "handled" });
      assert.equal(h.customEntries.length, 0);
      assert.equal(h.shutdowns(), 1);
      assert.deepEqual(h.snapshot().completionPayload, {
        kind: "error",
        errorMessage: 'Requested skill "missing" is unavailable in the child session',
        stopReason: "error",
      });
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
      assert.equal(result.terminate, true);
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
        assert.equal(result.terminate, undefined);
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
      const result = await execute(ping.tools.get("caller_ping"), { message: "need input" }, ping.ctx);
      assert.equal(result.terminate, true);
      ping.handlers.get("agent_end")!({ messages: assistant("stop") }, ping.ctx);
      ping.handlers.get("agent_settled")!({}, ping.ctx);
      ping.handlers.get("session_shutdown")!({ reason: "quit" }, ping.ctx);
      assert.deepEqual(ping.snapshot().completionPayload, { kind: "ping", name: "subagent", message: "need input" });
      assert.equal(ping.shutdowns(), 1);
      assert.ok(ping.snapshot().latestFacts.some((fact) => fact.kind === "session-shutdown"));
    } finally { ping.cleanup(); }
  });
});
