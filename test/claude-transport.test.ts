import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { confirmClaudeProcessGone, readClaudeFailureResult, readClaudePrintResult, readClaudeProcessId, validateClaudeReviewLaunch } from "../pi-extension/subagents/claude-transport.ts";
import { pollForExit } from "../pi-extension/subagents/cmux.ts";
import { buildVisibleWrapperCommand, readWrapperExitRecord } from "../pi-extension/subagents/completion.ts";
import * as subagents from "../pi-extension/subagents/index.ts";

describe("Claude foreground wrapper", () => {
  it("captures the real CLI PID, result, and correlated exit without calling a model", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-wrapper-shell-test-"));
    try {
      const cli = join(dir, "claude");
      const resultFile = join(dir, "result.json");
      const processIdFile = join(dir, "claude.pid");
      const wrapperExitFile = join(dir, "wrapper.json");
      writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"read-only review","session_id":"2ff3b2c1-d633-4200-b9da-87e1aaefb767"}'\n`);
      chmodSync(cli, 0o755);
      const command = (subagents as any).__test__.buildClaudeCommand({
        resultFile, processIdFile, runId: "shell-review", task: "inspect", cwd: dir,
      });
      execFileSync("bash", ["-c", buildVisibleWrapperCommand({
        piCommand: command, runId: "shell-review", wrapperExitFile,
      })], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 5_000 });
      assert.equal(readWrapperExitRecord(wrapperExitFile, "shell-review").ok, true);
      assert.ok((readClaudeProcessId(processIdFile, "shell-review") ?? 0) > 0);
      assert.equal(readClaudePrintResult(resultFile).summary, "read-only review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records foreground exit even when the PID sidecar cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-wrapper-pid-failure-"));
    try {
      const cli = join(dir, "claude");
      const wrapperExitFile = join(dir, "wrapper.json");
      writeFileSync(cli, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(cli, 0o755);
      const command = (subagents as any).__test__.buildClaudeCommand({
        resultFile: join(dir, "result.json"), processIdFile: join(dir, "absent", "claude.pid"),
        runId: "pid-failure", task: "inspect", cwd: dir,
      });
      const run = spawnSync("bash", ["-c", buildVisibleWrapperCommand({
        piCommand: command, runId: "pid-failure", wrapperExitFile,
      })], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 5_000 });
      assert.equal(run.status, 1);
      const wrapper = readWrapperExitRecord(wrapperExitFile, "pid-failure");
      assert.equal(wrapper.ok, true);
      if (wrapper.ok) assert.equal(wrapper.value.exit.shellStatus, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a nonzero exit after the CLI PID is stopped", { timeout: 6_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-wrapper-stop-test-"));
    const cli = join(dir, "claude");
    const processIdFile = join(dir, "claude.pid");
    const wrapperExitFile = join(dir, "wrapper.json");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      writeFileSync(cli, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(cli, 0o755);
      const command = (subagents as any).__test__.buildClaudeCommand({
        resultFile: join(dir, "result.json"), processIdFile, runId: "stopped-review", task: "inspect", cwd: dir,
      });
      child = spawn("bash", ["-c", buildVisibleWrapperCommand({
        piCommand: command, runId: "stopped-review", wrapperExitFile,
      })], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: "ignore" });
      let pid: number | null = null;
      for (let attempt = 0; attempt < 100 && pid === null; attempt++) {
        pid = readClaudeProcessId(processIdFile, "stopped-review");
        if (pid === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(pid, "CLI PID was never recorded");
      process.kill(pid!, "SIGTERM");
      const [exitCode] = await once(child, "exit");
      assert.notEqual(exitCode, 0);
      const wrapper = readWrapperExitRecord(wrapperExitFile, "stopped-review");
      assert.ok(wrapper.ok);
      assert.notEqual(wrapper.value.exit.shellStatus, 0);
      assert.equal(confirmClaudeProcessGone(processIdFile, "stopped-review"), true);
    } finally {
      if (child?.exitCode === null) child.kill("SIGTERM");
      const pid = readClaudeProcessId(processIdFile, "stopped-review");
      if (pid && !confirmClaudeProcessGone(processIdFile, "stopped-review")) process.kill(pid, "SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude review launch policy", () => {
  it("rejects wider authority and interactive/fork semantics before a pane is created", () => {
    assert.throws(() => validateClaudeReviewLaunch({ tools: "Bash" }, {}), /does not accept tools/);
    assert.throws(() => validateClaudeReviewLaunch({ skills: "verify-integration" }, {}), /does not accept skills/);
    assert.throws(() => validateClaudeReviewLaunch({ fork: true }, {}), /does not support fork/);
    assert.throws(() => validateClaudeReviewLaunch({ interactive: true }, {}), /does not support interactive/);
    assert.throws(() => validateClaudeReviewLaunch({ thinking: "high" }, { autoExit: true }), /thinking overrides/);
    assert.throws(() => validateClaudeReviewLaunch({ resumeSessionId: "bad-id" }, { autoExit: true }), /invalid Claude session ID/);
    assert.throws(() => validateClaudeReviewLaunch({ task: "x".repeat(60 * 1024 + 1) }, { autoExit: true }), /60 KiB/);
    assert.throws(() => validateClaudeReviewLaunch({ systemPrompt: "x".repeat(60 * 1024 + 1) }, { autoExit: true }), /60 KiB/);
    assert.doesNotThrow(() => validateClaudeReviewLaunch({
      resumeSessionId: "2ff3b2c1-d633-4200-b9da-87e1aaefb767",
    }, { autoExit: true }));
    const command = (subagents as any).__test__.buildClaudeCommand({
      resultFile: "/tmp/claude-result.json", processIdFile: "/tmp/claude.pid",
      runId: "option-prompt", task: "--tools Bash", cwd: "/tmp",
    });
    assert.match(command, /-- '--tools Bash' > '\/tmp\/claude-result\.json'/);
  });
});

describe("Claude print result", () => {
  it("returns the review and actual session ID from a successful run", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-result-test-"));
    try {
      const resultFile = join(dir, "result.json");
      writeFileSync(resultFile, JSON.stringify({
        type: "result", subtype: "success", is_error: false,
        result: "Found a mismatch in src/handler.ts:3", session_id: "2ff3b2c1-d633-4200-b9da-87e1aaefb767",
      }));
      assert.deepEqual(readClaudePrintResult(resultFile), {
        summary: "Found a mismatch in src/handler.ts:3",
        sessionId: "2ff3b2c1-d633-4200-b9da-87e1aaefb767",
      });
      writeFileSync(resultFile, JSON.stringify({
        type: "result", subtype: "error_max_turns", is_error: true,
        result: "partial", session_id: "2ff3b2c1-d633-4200-b9da-87e1aaefb767",
      }));
      assert.throws(() => readClaudePrintResult(resultFile), /not a successful resumable response/);
      assert.equal(readClaudeFailureResult(resultFile), "partial");
      writeFileSync(resultFile, "not JSON");
      assert.equal(readClaudeFailureResult(resultFile), undefined);
      assert.throws(() => readClaudePrintResult(resultFile), SyntaxError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Claude process-exit evidence", () => {
  it("identifies the CLI process from a run-correlated sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-pid-test-"));
    try {
      const file = join(dir, "claude.pid");
      assert.equal(readClaudeProcessId(file, "review-1"), null);
      writeFileSync(file, "review-1 4321\n");
      assert.equal(readClaudeProcessId(file, "review-1"), 4321);
      assert.equal(confirmClaudeProcessGone(file, "review-1", () => {}), false);
      assert.equal(confirmClaudeProcessGone(file, "review-1", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }), true);
      assert.equal(confirmClaudeProcessGone(file, "other-run", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }), false);
      assert.equal(readClaudeProcessId(file, "other-run"), null);
      writeFileSync(file, "review-1 0\n");
      assert.throws(() => readClaudeProcessId(file, "review-1"), /invalid Claude process ID/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a bounded deadline instead of waiting silently for a missing exit record", async () => {
    const started = Date.now();
    await assert.rejects(pollForExit("unused", AbortSignal.timeout(300), {
      interval: 2, wrapperExitFile: join(tmpdir(), "missing-claude-exit-record"),
      runId: "review-deadline", timeoutMs: 20,
    }), /Claude review deadline exceeded/);
    assert.ok(Date.now() - started < 300);
  });

  it("does not accept a wrapper record belonging to another run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-wrapper-test-"));
    try {
      const wrapperExitFile = join(dir, "wrapper.json");
      writeFileSync(wrapperExitFile, JSON.stringify({
        version: 1, runId: "other-run", sourceId: "wrapper:other-run", sequence: 1,
        observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 0 },
      }));
      await assert.rejects(pollForExit("unused", AbortSignal.timeout(25), {
        interval: 2, wrapperExitFile, runId: "review-1",
      }), /Aborted while waiting/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for a correlated wrapper record rather than a Stop-hook sentinel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-wrapper-test-"));
    try {
      const wrapperExitFile = join(dir, "wrapper.json");
      writeFileSync(join(dir, "stop-hook-sentinel"), "review ended");
      writeFileSync(wrapperExitFile, JSON.stringify({
        version: 1, runId: "review-1", sourceId: "wrapper:review-1", sequence: 1,
        observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 0 },
      }));
      const result = await pollForExit("unused", AbortSignal.timeout(300), {
        interval: 2, wrapperExitFile, runId: "review-1",
      });
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
