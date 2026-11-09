import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentRunState, projectAgentRunStatus, reduceAgentRunEvidence } from "pi-agent-execution";
import { buildVisibleCompletionPaths, buildVisibleWrapperCommand, createChildCompletionRecorder, readChildCompletionSnapshot, readWrapperExitRecord, readWrapperStartRecord } from "../pi-extension/subagents/completion.ts";

const tempDirs = new Set<string>();
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "completion-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe("visible completion sidecars", () => {
  it("builds unique owned paths and rejects traversal", () => {
    const dir = tempDir();
    assert.notDeepEqual(buildVisibleCompletionPaths(dir, "run-1"), buildVisibleCompletionPaths(dir, "run-2"));
    assert.throws(() => buildVisibleCompletionPaths(dir, "../escape"));
    assert.throws(() => buildVisibleCompletionPaths(dir, "a/b"));
  });

  it("round trips retained typed completion and independently sequenced facts", () => {
    const paths = buildVisibleCompletionPaths(tempDir(), "run-1");
    const recorder = createChildCompletionRecorder({ runId: "run-1", childPid: 42, sessionFile: "/tmp/s.jsonl", snapshotFile: paths.childSnapshot, now: () => "2026-09-09T00:00:00.000Z" });
    recorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
    recorder.record({ kind: "agent-ended" }); recorder.record({ kind: "agent-settled" });
    const result = readChildCompletionSnapshot(paths.childSnapshot, "run-1");
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.deepEqual(result.value.latestFacts.map(f => [f.kind, f.sequence]), [["completion-requested", 1], ["agent-ended", 2], ["agent-settled", 3]]);
    assert.deepEqual(result.value.completionPayload, { kind: "done" });
    assert.equal(statSync(paths.childSnapshot).mode & 0o777, 0o600);
    assert.equal(readChildCompletionSnapshot(paths.childSnapshot, "run-1", 3).reason, "stale");
    assert.ok(readFileSync(paths.childSnapshot, "utf8").includes("agent-settled"));
  });

  it("bounds latest facts while explicit intent remains nonterminal when folded into core", () => {
    const paths = buildVisibleCompletionPaths(tempDir(), "bounded");
    const recorder = createChildCompletionRecorder({ runId: "bounded", childPid: 7, sessionFile: "/s", snapshotFile: paths.childSnapshot });
    for (let i = 0; i < 30; i++) recorder.record({ kind: "progress", activity: `step ${i}`, estimated: false });
    recorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
    const result = readChildCompletionSnapshot(paths.childSnapshot, "bounded");
    assert.equal(result.ok, true); if (!result.ok) return;
    assert.ok(result.value.latestFacts.length <= 16);
    let state = createAgentRunState("bounded");
    for (const fact of result.value.latestFacts) state = reduceAgentRunEvidence(state, fact);
    assert.equal(projectAgentRunStatus(state).terminal, false);
  });

  it("rejects wrong identity, version, stale sequence, duplicate kinds, and array reasons", () => {
    const dir = tempDir(); const file = join(dir, "x.json");
    assert.equal(readChildCompletionSnapshot(file, "r").reason, "missing");
    writeFileSync(file, "nope"); assert.equal(readChildCompletionSnapshot(file, "r").reason, "invalid");
    const observedAt = new Date().toISOString();
    const base = { version: 1, runId: "other", sourceId: "pi-child:other", sequence: 1, observedAt, childPid: 1, sessionFile: "/s", latestFacts: [] };
    writeFileSync(file, JSON.stringify(base)); assert.equal(readChildCompletionSnapshot(file, "r").reason, "wrong-id");
    writeFileSync(file, JSON.stringify({ ...base, runId: "r", sourceId: "pi-child:r", version: 2 })); assert.equal(readChildCompletionSnapshot(file, "r").reason, "invalid");
    writeFileSync(file, JSON.stringify({ ...base, runId: "r", sourceId: "pi-child:r", sequence: 2 })); assert.equal(readChildCompletionSnapshot(file, "r", 2).reason, "stale");
    const fact = { kind: "completion-requested", reason: ["done"], runId: "r", sourceId: "pi-child:r", sequence: 1, observedAt };
    writeFileSync(file, JSON.stringify({ ...base, runId: "r", sourceId: "pi-child:r", completionPayload: { kind: "done" }, latestFacts: [fact] }));
    assert.equal(readChildCompletionSnapshot(file, "r").reason, "invalid");
    const progress = { kind: "progress", estimated: false, runId: "r", sourceId: "pi-child:r", observedAt };
    writeFileSync(file, JSON.stringify({ ...base, runId: "r", sourceId: "pi-child:r", sequence: 2, latestFacts: [{ ...progress, sequence: 1 }, { ...progress, sequence: 2 }] }));
    assert.equal(readChildCompletionSnapshot(file, "r").reason, "invalid");
  });

  it("preserves an unowned colliding temporary file", () => {
    const paths = buildVisibleCompletionPaths(tempDir(), "collision"); mkdirSync(join(paths.childSnapshot, ".."), { recursive: true });
    const collision = `${paths.childSnapshot}.${process.pid}.1.tmp`; writeFileSync(collision, "pre-existing");
    const recorder = createChildCompletionRecorder({ runId: "collision", childPid: 9, sessionFile: "/s", snapshotFile: paths.childSnapshot });
    assert.throws(() => recorder.record({ kind: "progress", estimated: false }));
    assert.equal(readFileSync(collision, "utf8"), "pre-existing");
  });

  it("records the original Bash wrapper before Pi with absolute writers and no PATH lookup", () => {
    const dir = tempDir();
    const paths = buildVisibleCompletionPaths(dir, "core-start");
    const startFile = join(dir, "core-start.wrapper-start.json");
    const marker = join(dir, "pi-started");
    const script = buildVisibleWrapperCommand({
      piCommand: `printf '%s|%s' "$$" "$HC_TERMINAL_ID" > ${JSON.stringify(marker)}`,
      runId: "core-start", wrapperExitFile: paths.wrapperExit,
      wrapperStartFile: startFile, nodeExecutable: process.execPath,
    });
    execFileSync("/bin/bash", ["-e", "-c", script], { env: { PATH: "/no-command-path", HC_TERMINAL_ID: "tchild" } });
    const observed = readWrapperStartRecord(startFile, "core-start", "tchild");
    assert.equal(observed.ok, true);
    if (!observed.ok) return;
    const start = observed.value;
    assert.equal(start.version, 1);
    assert.equal(start.runId, "core-start");
    assert.ok(Number.isSafeInteger(start.wrapperPid) && start.wrapperPid > 0);
    assert.equal(start.address, "tchild");
    assert.ok(Number.isFinite(Date.parse(start.observedAt)));
    assert.equal(statSync(startFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(marker, "utf8"), `${start.wrapperPid}|tchild`);
    assert.equal(readWrapperExitRecord(paths.wrapperExit, "core-start").ok, true);
  });

  it("validates wrapper-start run/address/PID identity and bounds", () => {
    const file = join(tempDir(), "start.json");
    assert.equal(readWrapperStartRecord(file, "r", "t2").reason, "missing");
    const base = { version: 1, runId: "r", wrapperPid: 12, address: "t2", observedAt: new Date().toISOString() };
    for (const [change, reason] of [
      [{ version: 2 }, "invalid"], [{ runId: "other" }, "wrong-id"],
      [{ address: "t3" }, "wrong-id"], [{ wrapperPid: 0 }, "invalid"],
      [{ observedAt: "yesterday" }, "invalid"],
    ] as const) {
      writeFileSync(file, JSON.stringify({ ...base, ...change }));
      assert.equal(readWrapperStartRecord(file, "r", "t2").reason, reason);
    }
    writeFileSync(file, " ".repeat(64 * 1024 + 1));
    assert.equal(readWrapperStartRecord(file, "r", "t2").reason, "invalid");
  });

  it("does not start Pi without a valid child Core identity", () => {
    const dir = tempDir();
    const marker = join(dir, "pi-must-not-start");
    for (const identity of ["", "parent-invented-id"]) {
      const script = buildVisibleWrapperCommand({
        piCommand: `printf started > ${JSON.stringify(marker)}`,
        runId: "invalid-core", wrapperExitFile: join(dir, "exit.json"),
        wrapperStartFile: join(dir, "start.json"), nodeExecutable: process.execPath,
      });
      assert.throws(() => execFileSync("/bin/bash", ["-c", script], { stdio: "pipe", env: { HC_TERMINAL_ID: identity } }));
      assert.throws(() => readFileSync(marker));
    }
  });

  it("does not start Pi if its wrapper-start record cannot be written", () => {
    const dir = tempDir();
    const marker = join(dir, "pi-must-not-start");
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "blocked");
    const script = buildVisibleWrapperCommand({
      piCommand: `printf started > ${JSON.stringify(marker)}`,
      runId: "blocked", wrapperExitFile: join(dir, "exit.json"),
      wrapperStartFile: join(blocked, "start.json"), nodeExecutable: process.execPath,
    });
    assert.throws(() => execFileSync("/bin/bash", ["-c", script], { stdio: "pipe", env: { HC_TERMINAL_ID: "tchild" } }));
    assert.throws(() => readFileSync(marker));
  });

  it("records after foreground return and preserves status 143 under bash -e", () => {
    const dir = tempDir(); const paths = buildVisibleCompletionPaths(dir, "quoted run");
    const marker = join(dir, "marker ' with spaces"); const fixture = join(dir, "fixture ' script.sh");
    writeFileSync(fixture, `#!/bin/sh\nprintf done > ${JSON.stringify(marker)}\nexit 143\n`); chmodSync(fixture, 0o700);
    const script = buildVisibleWrapperCommand({ piCommand: JSON.stringify(fixture), runId: "quoted run", wrapperExitFile: paths.wrapperExit, terminalSentinel: "diagnostic only" });
    let status = 0; let output = "";
    try { output = execFileSync("/bin/bash", ["-e", "-c", script], { encoding: "utf8" }); } catch (error: any) { status = error.status; output = error.stdout; }
    assert.equal(status, 143); assert.equal(output.trim(), "diagnostic only"); assert.equal(readFileSync(marker, "utf8"), "done");
    const result = readWrapperExitRecord(paths.wrapperExit, "quoted run"); assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.exit, { kind: "shell", shellStatus: 143 });
    assert.equal(statSync(paths.wrapperExit).mode & 0o777, 0o600);
  });
});
