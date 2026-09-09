import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildVisibleCompletionPaths,
  buildVisibleWrapperCommand,
  createChildCompletionRecorder,
  readChildCompletionSnapshot,
  readWrapperExitRecord,
} from "../pi-extension/subagents/completion.ts";

function tempDir() { return mkdtempSync(join(tmpdir(), "completion-")); }

describe("visible completion sidecars", () => {
  it("builds unique owned paths and rejects traversal", () => {
    const dir = tempDir();
    assert.notDeepEqual(buildVisibleCompletionPaths(dir, "run-1"), buildVisibleCompletionPaths(dir, "run-2"));
    assert.throws(() => buildVisibleCompletionPaths(dir, "../escape"));
    assert.throws(() => buildVisibleCompletionPaths(dir, "a/b"));
  });

  it("round trips retained child facts with distinct monotonic sequences", () => {
    const dir = tempDir();
    const paths = buildVisibleCompletionPaths(dir, "run-1");
    const recorder = createChildCompletionRecorder({ runId: "run-1", childPid: 42, sessionFile: "/tmp/s.jsonl", snapshotFile: paths.childSnapshot, now: () => "2026-09-09T00:00:00.000Z" });
    recorder.record({ kind: "completion-requested", reason: "done" });
    recorder.record({ kind: "agent-ended" });
    recorder.record({ kind: "agent-settled" });
    const result = readChildCompletionSnapshot(paths.childSnapshot, "run-1");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.snapshot.latestFacts.map(f => [f.kind, f.sequence]), [["completion-requested", 1], ["agent-ended", 2], ["agent-settled", 3]]);
    assert.equal(statSync(paths.childSnapshot).mode & 0o777, 0o600);
    assert.equal(readChildCompletionSnapshot(paths.childSnapshot, "run-1", 3).ok, false);
    assert.ok(readFileSync(paths.childSnapshot, "utf8").includes("agent-settled"));
  });

  it("bounds latest facts and treats intent alone as nonterminal in the core reducer", () => {
    const dir = tempDir();
    const paths = buildVisibleCompletionPaths(dir, "bounded");
    const recorder = createChildCompletionRecorder({ runId: "bounded", childPid: 7, sessionFile: "/s", snapshotFile: paths.childSnapshot });
    for (let i = 0; i < 30; i++) recorder.record({ kind: "progress", activity: `step ${i}`, estimated: false });
    recorder.record({ kind: "completion-requested", reason: "done" });
    const result = readChildCompletionSnapshot(paths.childSnapshot, "bounded");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.snapshot.latestFacts.length <= 16);
      assert.equal(result.state.process.status, "not-started");
      assert.equal(result.terminal, false);
    }
  });

  it("distinguishes missing, invalid, wrong identity, version, and stale data", () => {
    const dir = tempDir(); const file = join(dir, "x.json");
    assert.equal(readChildCompletionSnapshot(file, "r").reason, "missing");
    writeFileSync(file, "nope");
    assert.equal(readChildCompletionSnapshot(file, "r").reason, "invalid");
    const base = { version: 1, runId: "other", sourceId: "pi-child:other", sequence: 1, observedAt: new Date().toISOString(), childPid: 1, sessionFile: "/s", latestFacts: [] };
    writeFileSync(file, JSON.stringify(base));
    assert.equal(readChildCompletionSnapshot(file, "r").reason, "wrong-id");
    writeFileSync(file, JSON.stringify({ ...base, runId: "r", sourceId: "pi-child:r", version: 2 }));
    assert.equal(readChildCompletionSnapshot(file, "r").reason, "invalid");
    writeFileSync(file, JSON.stringify({ ...base, runId: "r", sourceId: "pi-child:r", sequence: 2 }));
    assert.equal(readChildCompletionSnapshot(file, "r", 2).reason, "stale");
  });

  it("runs the foreground command before atomically recording its raw shell status", () => {
    const dir = tempDir(); const paths = buildVisibleCompletionPaths(dir, "quoted run");
    const marker = join(dir, "marker ' with spaces");
    const fixture = join(dir, "fixture ' script.sh");
    writeFileSync(fixture, `#!/bin/sh\nprintf done > ${JSON.stringify(marker)}\nexit 143\n`); chmodSync(fixture, 0o700);
    const script = buildVisibleWrapperCommand({ piCommand: JSON.stringify(fixture), runId: "quoted run", wrapperExitFile: paths.wrapperExit, terminalSentinel: "diagnostic only" });
    let status = 0;
    try { execFileSync("/bin/sh", ["-c", script]); } catch (error: any) { status = error.status; }
    assert.equal(status, 143);
    assert.equal(readFileSync(marker, "utf8"), "done");
    const result = readWrapperExitRecord(paths.wrapperExit, "quoted run");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.record.exit, { kind: "shell", shellStatus: 143 });
    assert.equal(statSync(paths.wrapperExit).mode & 0o777, 0o600);
  });
});
