import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectAgentRunStatus } from "pi-agent-execution";
import { buildVisibleCompletionPaths, buildVisibleWrapperCommand, createChildCompletionRecorder } from "../pi-extension/subagents/completion.ts";
import { confirmOwnedProcessGone, createVisibleCompletionState, observeVisibleCompletion, recordVisibleControl, waitForVisibleCompletion } from "../pi-extension/subagents/completion-watch.ts";

const tempDirs = new Set<string>();
function fixture(runId = "run") {
  const dir = mkdtempSync(join(tmpdir(), "completion-watch-"));
  tempDirs.add(dir);
  const paths = buildVisibleCompletionPaths(dir, runId);
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session" })}\n`);
  const recorder = createChildCompletionRecorder({ runId, childPid: process.pid, sessionFile, snapshotFile: paths.childSnapshot });
  return { dir, paths, sessionFile, recorder, state: createVisibleCompletionState(runId) };
}
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});
function writeWrapper(paths: ReturnType<typeof buildVisibleCompletionPaths>, runId: string, status = 0) {
  execFileSync("/bin/sh", ["-c", buildVisibleWrapperCommand({ piCommand: `/bin/sh -c 'exit ${status}'`, runId, wrapperExitFile: paths.wrapperExit })]);
}

describe("visible parent completion observer", () => {
  it("keeps completion intent nonterminal and presents finishing", () => {
    const f = fixture();
    f.recorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
    const status = observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit });
    assert.equal(status.status, "finishing");
    assert.equal(status.terminal, false);
    assert.equal(f.state.core.process.status, "running");
  });

  it("delivers once only after settlement and wrapper exit using the fresh transcript offset", async () => {
    const f = fixture();
    writeFileSync(f.sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } })}\n`);
    const offset = 1;
    writeFileSync(f.sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } })}\n${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "fresh" }] } })}\n`);
    f.recorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
    f.recorder.record({ kind: "agent-settled" });
    assert.equal(observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit }).terminal, false);
    writeWrapper(f.paths, "run");
    const result = await waitForVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit, sessionFile: f.sessionFile, transcriptStartLine: offset, sessionRef: f.sessionFile, signal: new AbortController().signal, interval: 1 });
    assert.equal(result.completion.output, "fresh");
    assert.equal(result.completion.execution, "normal-exit");
    assert.equal(result.completion.sessionRef, f.sessionFile);
    assert.equal(observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit }).terminal, true);
  });

  it("returns the preceding summary when explicit done is a tool-only assistant message", async () => {
    const f = fixture();
    writeFileSync(f.sessionFile, [
      { type: "session", id: "session-1" },
      { type: "message", id: "summary", message: { role: "assistant", content: [{ type: "text", text: "FINAL REVIEW" }] } },
      { type: "message", id: "done", message: { role: "assistant", content: [{ type: "toolCall", name: "subagent_done", arguments: {} }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    f.recorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
    f.recorder.record({ kind: "agent-settled" });
    writeWrapper(f.paths, "run");

    const result = await waitForVisibleCompletion({
      state: f.state,
      childSnapshotFile: f.paths.childSnapshot,
      wrapperExitFile: f.paths.wrapperExit,
      sessionFile: f.sessionFile,
      transcriptStartLine: 1,
      signal: new AbortController().signal,
      interval: 1,
    });
    assert.equal(result.completion.output, "FINAL REVIEW");
  });

  it("does not recover stale text for non-explicit completion", async () => {
    const f = fixture();
    writeFileSync(f.sessionFile, [
      { type: "session", id: "session-1" },
      { type: "message", id: "stale", message: { role: "assistant", content: [{ type: "text", text: "STALE TEXT" }] } },
      { type: "message", id: "empty", message: { role: "assistant", content: [] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    f.recorder.record({ kind: "completion-requested", reason: "auto-exit" }, { kind: "done" });
    f.recorder.record({ kind: "agent-settled" });
    writeWrapper(f.paths, "run");

    const result = await waitForVisibleCompletion({
      state: f.state,
      childSnapshotFile: f.paths.childSnapshot,
      wrapperExitFile: f.paths.wrapperExit,
      sessionFile: f.sessionFile,
      transcriptStartLine: 1,
      signal: new AbortController().signal,
      interval: 1,
    });
    assert.equal(result.completion.output, "");
  });

  it("ignores malformed, wrong-run, legacy exit, and screen-like files", () => {
    const f = fixture();
    mkdirSync(join(f.dir, "subagent-completion"), { recursive: true });
    writeFileSync(f.paths.childSnapshot, "not json");
    writeFileSync(`${f.sessionFile}.exit`, JSON.stringify({ type: "done" }));
    writeFileSync(join(f.dir, "screen.txt"), "__SUBAGENT_DONE_0__");
    assert.equal(observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit }).terminal, false);
    writeFileSync(f.paths.childSnapshot, JSON.stringify({ version: 1, runId: "old", sourceId: "pi-child:old" }));
    assert.equal(observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit }).terminal, false);
    assert.ok(f.state.diagnostics.length > 0);
  });

  it("retains parent control cause while child progress clears only turn escape", () => {
    const f = fixture();
    recordVisibleControl(f.state, { kind: "interrupt-requested", mode: "turn-escape" });
    assert.equal(projectAgentRunStatus(f.state.core).status, "interrupted");
    f.recorder.record({ kind: "progress", activity: "again", estimated: false });
    observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit });
    assert.equal(f.state.core.control.status, "none");
    recordVisibleControl(f.state, { kind: "terminate-requested", mode: "herdr-pane-close" });
    f.recorder.record({ kind: "agent-settled" });
    observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit });
    assert.equal(f.state.core.control.status, "terminate-requested");
  });

  it("confirms only an owned recorded PID disappearing", async () => {
    const f = fixture();
    assert.equal(confirmOwnedProcessGone(f.state), false);
    f.recorder.record({ kind: "progress", estimated: false });
    observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit });
    assert.equal(confirmOwnedProcessGone(f.state, () => { const error = Object.assign(new Error("gone"), { code: "ESRCH" }); throw error; }), true);
    assert.deepEqual(f.state.core.process, { status: "exited", exit: { kind: "process-not-found" } });
  });

  it("rechecks an accepted termination until the recorded PID disappears", async () => {
    const f = fixture();
    f.recorder.record({ kind: "progress", estimated: false });
    observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit });
    recordVisibleControl(f.state, { kind: "terminate-requested", mode: "herdr-pane-close" });
    let probes = 0;
    const result = await waitForVisibleCompletion({
      state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit,
      sessionFile: f.sessionFile, transcriptStartLine: 0, sessionRef: f.sessionFile,
      signal: new AbortController().signal, interval: 1,
      processProbe() { if (++probes < 3) return; throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
    });
    assert.equal(probes, 3);
    assert.equal(result.completion.execution, "terminated");
    assert.deepEqual(result.completion.processExit, { kind: "process-not-found" });
  });

  it("rejects changed child identity and bounds alternating corruption diagnostics", () => {
    const f = fixture();
    f.recorder.record({ kind: "progress", estimated: false });
    observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit });
    const foreign = createChildCompletionRecorder({ runId: "run", childPid: process.pid + 1, sessionFile: "/foreign", snapshotFile: f.paths.childSnapshot });
    foreign.record({ kind: "progress", estimated: false });
    foreign.record({ kind: "agent-settled" });
    for (let i = 0; i < 20; i++) {
      writeFileSync(i % 2 ? f.paths.childSnapshot : f.paths.wrapperExit, "{");
      observeVisibleCompletion({ state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit });
    }
    assert.equal(f.state.childPid, process.pid);
    assert.ok(f.state.diagnostics.length <= 8);
  });

  it("observes an onTick abort without installing a missed timer", async () => {
    const f = fixture();
    const controller = new AbortController();
    await assert.rejects(waitForVisibleCompletion({
      state: f.state, childSnapshotFile: f.paths.childSnapshot, wrapperExitFile: f.paths.wrapperExit,
      sessionFile: f.sessionFile, transcriptStartLine: 0, signal: controller.signal, interval: 10_000,
      onTick() { controller.abort("parent cancellation"); throw new Error("callback diagnostic"); },
    }), /parent cancellation/);
    assert.ok(f.state.diagnostics.some((message) => message.includes("callback diagnostic")));
  });
});
