import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import extension, { __test__ } from "../pi-extension/subagents/index.ts";

// No launcher, Core endpoint, provider or project extension is used.
test("deleted and unknown explicit agents fail before launch preparation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-validation-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let sessionAccesses = 0;
  const sessionAccess = (): never => { sessionAccesses++; throw new Error("unexpected session access"); };
  const ctx = { cwd: dir, sessionManager: { getSessionFile: sessionAccess, getSessionId: sessionAccess, getSessionDir: sessionAccess } };
  try {
    for (const agent of ["claude-code", "unknown-test-agent"]) {
      assert.equal(__test__.loadAgentDefaults(agent, dir), null);
      await assert.rejects(__test__.launchSubagent({ name: "Rejected", task: "inspect", agent }, ctx), new RegExp(`Unknown agent: ${agent}`));
    }
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "old-review.md"), "---\nname: old-review\ncli: claude\n---\nReview.");
    await assert.rejects(__test__.launchSubagent({ name: "Rejected", task: "inspect", agent: "old-review" }, ctx), /cli/i);
    assert.equal(sessionAccesses, 0);
    // A bare request still resolves to ordinary Pi; no definition is required.
    assert.equal(Value.Check(__test__.SubagentParams, { name: "Pi", task: "inspect" }), true);
    assert.doesNotThrow(() => __test__.resolveVisibleLaunchIntent({ name: "Pi", task: "inspect" }, null, dir));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn schema and launch seam reject retired and unknown controls, including blank values", async () => {
  const ctx = { cwd: "/unused", sessionManager: { getSessionFile(): never { throw new Error("unexpected session access"); }, getSessionId(): never { throw new Error("unexpected session access"); }, getSessionDir(): never { throw new Error("unexpected session access"); } } };
  const blankAgent = { name: "Rejected", task: "inspect", agent: "" };
  assert.equal(Value.Check(__test__.SubagentParams, blankAgent), false);
  await assert.rejects(__test__.launchSubagent(blankAgent, ctx), /Invalid subagent parameters/);
  for (const field of ["resumeSessionId", "claudeSessionId", "unknownControl"]) {
    for (const value of ["", "old-session"]) {
      const params = { name: "Rejected", task: "inspect", [field]: value };
      assert.equal(Value.Check(__test__.SubagentParams, params), false);
      await assert.rejects(__test__.launchSubagent(params, ctx), /Invalid subagent parameters/);
    }
  }
});

test("registered resume schema rejects retired controls and preserves Pi/native shapes", () => {
  const tools = new Map<string, any>();
  extension({ events: { on() {}, emit() {} }, on() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} } as any);
  const schema = tools.get("subagent_resume").parameters;
  assert.equal(Value.Check(schema, { sessionPath: "/session.jsonl", name: "Pi follow-up" }), true);
  assert.equal(Value.Check(schema, { managedSessionId: "managed", agent: "native", message: "follow up", autoExit: true }), true);
  for (const field of ["resumeSessionId", "claudeSessionId", "unknownControl"]) {
    assert.equal(Value.Check(schema, { sessionPath: "/session.jsonl", [field]: "" }), false);
  }
});
