import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RESUME_POLICY_CUSTOM_TYPE,
  createResumePolicy,
  parseLaunchPolicySeed,
  readResumePolicy,
  serializeLaunchPolicySeed,
} from "../pi-extension/subagents/resume-policy.ts";

const seed = {
  version: 1 as const,
  agent: "worker",
  deniedTools: ["subagent", "subagent_resume"],
  cwd: "/work/project",
  agentDir: "/work/agent",
  systemPrompt: { mode: "append" as const, text: "Worker role" },
};

function withSession(lines: unknown[], run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "resume-policy-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  try { run(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("resume launch policy", () => {
  it("round-trips a strict launcher-owned seed", () => {
    assert.deepEqual(parseLaunchPolicySeed(serializeLaunchPolicySeed(seed)), seed);
    assert.throws(
      () => parseLaunchPolicySeed(JSON.stringify({ ...seed, deniedTools: ["subagent", "subagent"] })),
      /deniedTools/,
    );
    assert.throws(
      () => parseLaunchPolicySeed(JSON.stringify({ ...seed, extra: true })),
      /unexpected field/,
    );
  });

  it("binds captured active tools to the Pi session id", () => {
    const policy = createResumePolicy(seed, "session-1", ["read", "caller_ping", "subagent_done"]);
    assert.deepEqual(policy, {
      ...seed,
      sessionId: "session-1",
      activeTools: ["caller_ping", "read", "subagent_done"],
    });
    assert.throws(() => createResumePolicy(seed, "session-1", ["read", "read"]), /activeTools/);
  });

  it("reads exactly one valid policy bound to the session header", () => {
    const policy = createResumePolicy(seed, "session-1", ["read", "subagent_done"]);
    withSession([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/work/project" },
      { type: "custom", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z", customType: RESUME_POLICY_CUSTOM_TYPE, data: policy },
    ], (path) => assert.deepEqual(readResumePolicy(path), policy));
  });

  it("fails closed for missing, malformed, mismatched, or conflicting provenance", () => {
    const policy = createResumePolicy(seed, "session-1", ["read"]);
    const header = { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/work/project" };
    const entry = { type: "custom", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z", customType: RESUME_POLICY_CUSTOM_TYPE, data: policy };

    withSession([header], (path) => assert.throws(() => readResumePolicy(path), /missing trusted resume policy/));
    withSession([header, { ...entry, data: { ...policy, activeTools: "read" } }], (path) => assert.throws(() => readResumePolicy(path), /invalid resume policy/));
    withSession([header, { ...entry, data: { ...policy, sessionId: "other" } }], (path) => assert.throws(() => readResumePolicy(path), /missing trusted resume policy/));
    withSession([header, entry, { ...entry, id: "b" }], (path) => assert.throws(() => readResumePolicy(path), /conflicting resume policies/));
  });

  it("ignores an inherited parent policy bound to another session id", () => {
    const own = createResumePolicy(seed, "session-1", ["read"]);
    const inherited = createResumePolicy(seed, "parent-session", ["bash"]);
    withSession([
      { type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00Z", cwd: "/work/project" },
      { type: "custom", id: "parent", parentId: null, timestamp: "2026-01-01T00:00:01Z", customType: RESUME_POLICY_CUSTOM_TYPE, data: inherited },
      { type: "custom", id: "own", parentId: "parent", timestamp: "2026-01-01T00:00:02Z", customType: RESUME_POLICY_CUSTOM_TYPE, data: own },
    ], (path) => assert.deepEqual(readResumePolicy(path), own));
  });
});
