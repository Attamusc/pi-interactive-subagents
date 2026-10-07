import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildVisibleWrapperCommand, readWrapperExitRecord } from "../pi-extension/subagents/completion.ts";
import { readClaudePrintResult, readClaudeProcessId } from "../pi-extension/subagents/claude-transport.ts";
import * as subagents from "../pi-extension/subagents/index.ts";

const uuid = "2ff3b2c1-d633-4200-b9da-87e1aaefb767";
const result = (text = "review", id = uuid) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: id });
const scriptLine = (value: unknown) => `printf '%s\\n' '${JSON.stringify(value).replaceAll("'", "'\\''")}'\n`;

type Run = { output: string; error: string; status: number | null; elapsed: number; dir: string; resultFile: string; pid: number | null; wrapperOk: boolean };
async function fakeRun(body: string, options: { task?: string; model?: string; systemPrompt?: string; resumeSessionId?: string; timeout?: number; closeOutput?: boolean } = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "claude-stream-contract-"));
  const cli = join(dir, "claude");
  const resultFile = join(dir, "result.json");
  const pidFile = join(dir, "cli.pid");
  const wrapperExitFile = join(dir, "wrapper.json");
  writeFileSync(cli, `#!/bin/sh\n${body}`);
  chmodSync(cli, 0o755);
  const command = (subagents as any).__test__.buildClaudeCommand({
    resultFile, processIdFile: pidFile, runId: "contract", task: options.task ?? "inspect", cwd: dir,
    model: options.model, systemPrompt: options.systemPrompt, resumeSessionId: options.resumeSessionId,
  });
  const child = spawn("bash", ["-c", buildVisibleWrapperCommand({ piCommand: command, runId: "contract", wrapperExitFile })], {
    detached: true, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  if (options.closeOutput) child.stdout!.destroy();
  let output = "", error = "", status: number | null = null;
  const started = Date.now();
  child.stdout!.on("data", chunk => { output += String(chunk).slice(0, 25_000); });
  child.stderr!.on("data", chunk => { error += String(chunk).slice(0, 4_000); });
  const timeout = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, options.timeout ?? 2500);
  try {
    status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code));
    });
    const elapsed = Date.now() - started;
    const pid = readClaudeProcessId(pidFile, "contract");
    const wrapperOk = readWrapperExitRecord(wrapperExitFile, "contract").ok;
    return { output, error, status, elapsed, dir, resultFile, pid, wrapperOk };
  } finally {
    clearTimeout(timeout);
    // Detached group cleanup also covers a native CLI that survives a failed formatter.
    try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    const pid = readClaudeProcessId(pidFile, "contract");
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  }
}
function cleanup(run: Run) { rmSync(run.dir, { recursive: true, force: true }); }

describe("native Claude stream result integrity", () => {
  for (const [name, body] of [
    ["empty", "exit 0\n"],
    ["malformed", "printf '%s\\n' '{not-json}'\n"],
    ["truncated", `printf '%s' '${result()}'\n`],
    ["duplicate", scriptLine(JSON.parse(result())) + scriptLine(JSON.parse(result()))],
    ["oversized line", `printf '%*s\\n' 1100000 ''\n`],
    ["invalid UTF-8", "printf '\\377\\n'\n"],
    ["empty success", scriptLine(JSON.parse(result("")))],
    ["invalid UUID", scriptLine(JSON.parse(result("review", "not-a-uuid")))],
  ] as const) {
    it(`rejects ${name} without publishing success`, { timeout: 4000 }, async () => {
      const run = await fakeRun(body);
      try {
        assert.ok(run.wrapperOk, "correlated wrapper exit must exist");
        assert.notEqual(run.status, 0, "invalid result must fail wrapper");
        if (existsSync(run.resultFile)) assert.throws(() => readClaudePrintResult(run.resultFile));
      } finally { cleanup(run); }
    });
  }
  it("rejects a native nonzero exit even after a success result", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine(JSON.parse(result())) + "exit 7\n");
    try {
      assert.equal(run.status, 7);
      const wrapper = readWrapperExitRecord(join(run.dir, "wrapper.json"), "contract");
      assert.ok(wrapper.ok);
      assert.equal(wrapper.value.exit.shellStatus, 7);
    } finally { cleanup(run); }
  });
  it("accepts native informational messages after the single result", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine(JSON.parse(result())) + scriptLine({ type: "system", subtype: "task_notification", details: "SECRET_NOTIFICATION" }));
    try {
      assert.equal(run.status, 0);
      assert.equal(readClaudePrintResult(run.resultFile).summary, "review");
      assert.doesNotMatch(run.output + readFileSync(run.resultFile, "utf8"), /SECRET_NOTIFICATION/);
    } finally { cleanup(run); }
  });
  it("retains the native success-subtype API error as failure evidence", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine({ type: "result", subtype: "success", is_error: true, result: "API error", session_id: uuid }));
    try {
      assert.notEqual(run.status, 0);
      assert.equal(JSON.parse(readFileSync(run.resultFile, "utf8")).result, "API error");
      assert.throws(() => readClaudePrintResult(run.resultFile));
    } finally { cleanup(run); }
  });
  it("preserves a bounded native failure result without publishing success", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine({ type: "result", subtype: "error_max_turns", is_error: true, result: "partial", session_id: uuid }));
    try {
      assert.notEqual(run.status, 0);
      assert.equal(JSON.parse(readFileSync(run.resultFile, "utf8")).result, "partial");
      assert.throws(() => readClaudePrintResult(run.resultFile));
    } finally { cleanup(run); }
  });
  it("drains a native failure result before preserving its nonzero exit", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine({ type: "result", subtype: "error_max_turns", is_error: true, result: "native failure evidence", session_id: uuid }) + "exit 7\n");
    try {
      assert.equal(run.status, 7);
      assert.equal(JSON.parse(readFileSync(run.resultFile, "utf8")).result, "native failure evidence");
      assert.throws(() => readClaudePrintResult(run.resultFile));
    } finally { cleanup(run); }
  });
  it("rejects malformed input promptly and reaps a native CLI that keeps writing", { timeout: 4000 }, async () => {
    const run = await fakeRun("printf '%s\\n' '{bad}'\nsleep 10\n", { timeout: 2200 });
    try {
      assert.ok(run.elapsed < 2000, `CLI was not reaped: ${run.elapsed}ms`);
      assert.notEqual(run.status, 0);
      assert.ok(run.pid);
      assert.throws(() => process.kill(run.pid!, 0), { code: "ESRCH" });
    } finally { cleanup(run); }
  });
  it("reaps the native CLI when pane output closes (EPIPE)", { timeout: 4000 }, async () => {
    const body = scriptLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "live output" } } }) + "exec sleep 10\n";
    const run = await fakeRun(body, { closeOutput: true, timeout: 2200 });
    try {
      assert.ok(run.elapsed < 2000);
      assert.notEqual(run.status, 0);
      assert.ok(run.wrapperOk);
      assert.ok(run.pid);
      assert.throws(() => process.kill(run.pid!, 0), { code: "ESRCH" });
      assert.match(run.error, /pane output failed/);
    } finally { cleanup(run); }
  });
  it("rejects oversized result bytes", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine(JSON.parse(result("x".repeat(1_100_000)))));
    try { assert.notEqual(run.status, 0); assert.equal(existsSync(run.resultFile), false); } finally { cleanup(run); }
  });
  it("preserves native2 when formatter detects a malformed tail after native exit", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine(JSON.parse(result())) + "printf '%s' '{bad tail'\nexit 2\n");
    try {
      assert.equal(run.status, 2);
      const wrapper = readWrapperExitRecord(join(run.dir, "wrapper.json"), "contract");
      assert.ok(wrapper.ok);
      assert.equal(wrapper.value.exit.shellStatus, 2);
    } finally { cleanup(run); }
  });
  it("keeps full 20k final summary and only one final JSON result", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine(JSON.parse(result("z".repeat(18_000)))));
    try {
      assert.equal(run.status, 0);
      assert.equal(readClaudePrintResult(run.resultFile).summary.length, 18_000);
      assert.equal(JSON.parse(readFileSync(run.resultFile, "utf8")).type, "result");
    } finally { cleanup(run); }
  });
  it("accepts multiple NDJSON records while withholding private content", { timeout: 4000 }, async () => {
    const visible = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "snow ☃" } } };
    const privateRecord = { type: "assistant", message: { content: [{ type: "thinking", thinking: "SECRET_THOUGHT" }, { type: "tool_use", name: "Grep", input: { pattern: "SECRET_ARGUMENT" } }] } };
    const run = await fakeRun(scriptLine(visible) + scriptLine(privateRecord) + scriptLine(JSON.parse(result())));
    try {
      assert.equal(run.status, 0);
      assert.match(run.output, /snow ☃/);
      assert.match(run.output, /\[Grep\]/);
      assert.doesNotMatch(run.output, /SECRET/);
      assert.doesNotMatch(readFileSync(run.resultFile, "utf8"), /SECRET|snow|Grep/);
    } finally { cleanup(run); }
  });
  it("caps pane text while hiding tool results, init metadata and non-read-only names", { timeout: 4000 }, async () => {
    const body = scriptLine({ type: "system", subtype: "init", config: "SECRET_CONFIG" }) +
      scriptLine({ type: "user", message: { content: [{ type: "tool_result", content: "SECRET_FILE" }] } }) +
      scriptLine({ type: "assistant", message: { content: [
        { type: "tool_use", name: "Glob", input: "SECRET_ARGUMENT" },
        { type: "tool_use", name: "Bash", input: "SECRET_COMMAND" },
        { type: "tool_use", name: "mcp__private", input: "SECRET_MCP" },
      ] } }) +
      scriptLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(40_000) } } }) +
      scriptLine(JSON.parse(result()));
    const run = await fakeRun(body);
    try {
      assert.equal(run.status, 0);
      assert.ok(run.output.length <= 20_000);
      assert.match(run.output, /^\[Glob\]/);
      assert.doesNotMatch(run.output + run.error + readFileSync(run.resultFile, "utf8"), /SECRET|\[Bash\]|mcp__private|--safe-mode/);
    } finally { cleanup(run); }
  });
  it("does not cut a surrogate pair at the pane cap", { timeout: 4000 }, async () => {
    const run = await fakeRun(scriptLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(19_999) + "😀" } } }) + scriptLine(JSON.parse(result())));
    try {
      assert.equal(run.status, 0);
      assert.ok(!run.output.includes("�"), "pane cap must not emit a replacement character");
      assert.ok(run.output.length <= 20_000);
    } finally { cleanup(run); }
  });
  it("decodes a UTF-8 codepoint split across native writes", { timeout: 4000 }, async () => {
    const body = "printf '%s' '{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"snow '" +
      "\nprintf '\\342'\nsleep 0.02\nprintf '\\230\\203\"}}}\\n'\n" + scriptLine(JSON.parse(result()));
    const run = await fakeRun(body);
    try {
      assert.equal(run.status, 0);
      assert.match(run.output, /snow ☃/);
    } finally { cleanup(run); }
  });
  it("records the actual native CLI PID rather than the formatter PID", { timeout: 4000 }, async () => {
    const run = await fakeRun("printf '%s\\n' \"$$\" > native-pid.txt\n" + scriptLine(JSON.parse(result())));
    try {
      assert.equal(run.status, 0);
      assert.equal(run.pid, Number(readFileSync(join(run.dir, "native-pid.txt"), "utf8").trim()));
    } finally { cleanup(run); }
  });
  it("does not print OSC/CSI/C1/bidi controls or their terminal-command payload", { timeout: 4000 }, async () => {
    const fragments = ["before \u001b]52;c;SECRET_OSC", "\u0007 \u001b[31m red \u009b2J \u202e reversed"];
    const body = fragments.map(text => scriptLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } })).join("") + scriptLine(JSON.parse(result()));
    const run = await fakeRun(body);
    try {
      assert.equal(run.status, 0);
      assert.doesNotMatch(run.output, /SECRET_OSC|52;c|31m|2J|[\x1b\x9b\u202e]/);
    } finally { cleanup(run); }
  });
  it("passes option-like task, system prompt, model, resume and cwd as exact argv", { timeout: 4000 }, async () => {
    const task = "--tools Bash 'quoted'";
    const systemPrompt = "system 'quoted'";
    const body = `printf '%s\\n' "$PWD" "$@" > argv.txt\n${scriptLine(JSON.parse(result()))}`;
    const run = await fakeRun(body, { task, systemPrompt, model: "sonnet", resumeSessionId: uuid });
    try {
      assert.equal(run.status, 0);
      const args = readFileSync(join(run.dir, "argv.txt"), "utf8");
      assert.match(args, /--safe-mode\n--restricted\n--strict-mcp-config/);
      assert.match(args, /--permission-mode\ndontAsk\n--tools\nRead,Glob,Grep\n--allowedTools\nRead\nGlob\nGrep\n--disallowedTools\nmcp__\*/);
      assert.match(args, /--max-turns\n16/);
      assert.match(args, /--output-format\nstream-json/);
      assert.match(args, /--append-system-prompt\nsystem 'quoted'/);
      assert.match(args, /--resume\n2ff3b2c1-d633-4200-b9da-87e1aaefb767/);
      assert.ok(args.endsWith(`--\n${task}\n`));
      assert.equal(args.split("\n")[0], run.dir);
    } finally { cleanup(run); }
  });
});
