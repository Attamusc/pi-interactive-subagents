import { it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test__ } from "../pi-extension/subagents/index.ts";
import { readClaudeProcessId } from "../pi-extension/subagents/claude-transport.ts";
import { buildVisibleWrapperCommand, readWrapperExitRecord } from "../pi-extension/subagents/completion.ts";

for (const [tostop, heldOutput] of [[false, false], [true, false], [true, true]]) {
  it(`keeps native identity foreground and bounds held output under a controlling PTY (tostop=${tostop}, held=${heldOutput})`,
    { skip: process.platform !== "linux", timeout: 6000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-pty-"));
    try {
      const cli = join(dir, "claude");
      writeFileSync(cli, `#!/usr/bin/env python3
import json, os, signal, subprocess
if os.environ.get("HOLD_OUTPUT") == "1":
    subprocess.Popen(["sleep", "30"], preexec_fn=lambda: signal.signal(signal.SIGHUP, signal.SIG_IGN))
tty = os.open("/dev/tty", os.O_RDONLY)
measurement = {"pid":os.getpid(), "group":os.getpgrp(), "foreground":os.tcgetpgrp(tty), "stdin_tty":os.isatty(0)}
os.close(tty)
with open("native-tty.json", "w") as f:
    json.dump(measurement, f)
print(json.dumps({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"PTY_PROGRESS"}}}), flush=True)
print(json.dumps({"type":"result","subtype":"success","is_error":False,"result":"PTY_DONE","session_id":"2ff3b2c1-d633-4200-b9da-87e1aaefb767"}), flush=True)
`);
      chmodSync(cli, 0o755);
      const wrapperExitFile = join(dir, "exit.json");
      const command = __test__.buildClaudeCommand({ resultFile: join(dir, "result.json"), processIdFile: join(dir, "pid"), runId: "pty", task: "fixture", cwd: dir });
      const script = join(dir, "run.sh");
      writeFileSync(script, buildVisibleWrapperCommand({ piCommand: command, runId: "pty", wrapperExitFile }));
      const report = join(dir, "report.json");
      execFileSync("python3", [join(dirname(fileURLToPath(import.meta.url)), "fixtures/claude-pty.py"), script, report, tostop ? "1" : "0"],
        { env: { ...process.env, HOLD_OUTPUT: heldOutput ? "1" : "0", PATH: `${dir}:${process.env.PATH}` }, timeout: 4500 });
      const measured = JSON.parse(readFileSync(report, "utf8"));
      const native = JSON.parse(readFileSync(join(dir, "native-tty.json"), "utf8"));
      assert.equal(measured.status, heldOutput ? 1 : 0, `wrapper must settle; status=${measured.status}, native=${JSON.stringify(native)}`);
      assert.equal(native.group, native.foreground, `native agent must be in foreground detection group: ${JSON.stringify(native)}`);
      assert.equal(readClaudeProcessId(join(dir, "pid"), "pty"), native.pid, "sidecar must identify the actual CLI");
      if (heldOutput) {
        assert.ok(measured.live_session_before_owner_cleanup.length > 0, "owner must see the live pipe-holder before cleanup");
      } else {
        assert.deepEqual(measured.live_session_before_owner_cleanup, [], "normal completion must not leave session descendants");
      }
      assert.ok(measured.output.includes("PTY_PROGRESS"), "progress must reach controlling PTY");
      const wrapper = readWrapperExitRecord(wrapperExitFile, "pty");
      assert.equal(wrapper.ok, true);
      if (wrapper.ok) assert.equal(wrapper.value.exit.shellStatus, heldOutput ? 1 : 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
