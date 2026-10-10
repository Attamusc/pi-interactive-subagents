import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { confirmClaudeProcessGone, readClaudeProcessId } from "../../pi-extension/subagents/claude-transport.ts";
import { ClaudeExitTimeoutError, pollForExit } from "../../pi-extension/subagents/cmux.ts";
import { buildVisibleWrapperCommand } from "../../pi-extension/subagents/completion.ts";
import * as subagents from "../../pi-extension/subagents/index.ts";

const enabled = process.env.PI_TEST_CLAUDE_HERDR_FAILURE === "approved";
function herdr(args: string[]): any {
  const output = execFileSync("herdr", args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  return output ? JSON.parse(output).result : {};
}
async function until<T>(label: string, probe: () => T | undefined, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

it("closes an overdue Claude pane without claiming wrapper exit", { skip: !enabled, timeout: 20_000 }, async () => {
  assert.equal(process.env.HERDR_ENV, "1");
  const dir = mkdtempSync(join(tmpdir(), "claude-herdr-failure-"));
  const bin = join(dir, "bin");
  const cli = join(bin, "claude");
  const script = join(dir, "review.sh");
  const processIdFile = join(dir, "review.pid");
  const wrapperExitFile = join(dir, "review.wrapper.json");
  const runId = "overdue-review";
  let workspaceId: string | undefined;
  try {
    mkdirSync(bin);
    writeFileSync(cli, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(cli, 0o755);
    const command = (subagents as any).__test__.buildClaudeCommand({
      resultFile: join(dir, "review.json"), processIdFile, runId, task: "fixture", cwd: dir,
    });
    writeFileSync(script, buildVisibleWrapperCommand({ piCommand: command, runId, wrapperExitFile }));
    const created = herdr(["workspace", "create", "--cwd", dir, "--label", "TEST Claude termination", "--no-focus"]);
    workspaceId = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    const guardedCommand = `export PATH=${JSON.stringify(bin)}:"$PATH"; ` +
      `if [ "$(command -v claude)" != ${JSON.stringify(cli)} ]; then exit 42; fi; ` +
      `bash ${JSON.stringify(script)}`;
    herdr(["pane", "run", pane, guardedCommand]);
    await until("fake CLI PID", () => readClaudeProcessId(processIdFile, runId) ?? undefined);
    await assert.rejects(pollForExit(pane, new AbortController().signal, {
      runId, wrapperExitFile, timeoutMs: 250, interval: 25,
    }), ClaudeExitTimeoutError);
    assert.equal(confirmClaudeProcessGone(processIdFile, runId), false);
    herdr(["pane", "close", pane]);
    await until("CLI exit after Herdr pane close", () => confirmClaudeProcessGone(processIdFile, runId) || undefined);
    // A killed pane need not run the wrapper's finalizer: PID absence proves exit.
  } finally {
    try {
      if (workspaceId) {
        try { herdr(["workspace", "close", workspaceId]); }
        catch (error) {
          if (!String(error).includes("workspace_not_found")) throw error;
        }
      }
    } finally {
      const pid = readClaudeProcessId(processIdFile, runId);
      if (pid && !confirmClaudeProcessGone(processIdFile, runId)) {
        process.kill(pid, "SIGTERM");
        await until("fake CLI cleanup", () => confirmClaudeProcessGone(processIdFile, runId) || undefined);
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
