import { spawn } from "node:child_process";
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

// One foreground invocation, not a daemon/session/status owner. Both children
// stay in Herdr's existing PTY session and foreground detection group.
const [resultFile, processIdFile, runId, cwd, ...command] = process.argv.slice(2);
const cli = spawn(command[0], command.slice(1), { cwd: cwd || undefined, stdio: ["ignore", "pipe", "inherit"] });
const formatter = spawn(process.execPath, [fileURLToPath(new URL("./claude-stream.ts", import.meta.url)), resultFile],
  { stdio: ["pipe", "inherit", "inherit"] });
let failed = false;
let startupFailed = false;
const cancel = () => {
  failed = true;
  if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
  cli.stdout?.destroy();
  formatter.stdin?.destroy();
};
cli.on("error", cancel);
cli.stdout?.on("error", cancel);
formatter.on("error", cancel);
formatter.stdin?.on("error", cancel);
const cliExit = new Promise<number>((resolve) => {
  cli.once("error", () => resolve(1));
  cli.once("exit", (code, signal) => resolve(code ?? 128 + (constants.signals[signal!] ?? 0)));
});
const formatterExit = new Promise<number>((resolve) => {
  formatter.once("error", () => resolve(1));
  formatter.once("exit", (code, signal) => {
    const status = code ?? 128 + (constants.signals[signal!] ?? 0);
    if (status !== 0 && cli.exitCode === null && cli.signalCode === null) cancel();
    resolve(status);
  });
});
try {
  rmSync(resultFile, { force: true });
  await new Promise<void>((resolve, reject) => {
    cli.once("spawn", resolve);
    cli.once("error", reject);
  });
  writeFileSync(`${processIdFile}.tmp`, `${runId} ${cli.pid}\n`, { mode: 0o600 });
  renameSync(`${processIdFile}.tmp`, processIdFile);
  cli.stdout!.pipe(formatter.stdin!);
} catch {
  startupFailed = true;
  cancel();
  console.error("Claude transport: CLI PID record or startup failed");
}
const nativeStatus = await cliExit;
if (failed) formatter.kill("SIGKILL");
// A native descendant can retain the writer after the CLI exits. Bound only
// this post-exit IO drain; Herdr's existing pane close owns session cleanup.
const drainDeadline = setTimeout(() => {
  failed = true;
  console.error("Claude transport: output remained open after native exit");
  cli.stdout?.destroy();
  formatter.stdin?.end();
}, 1000);
const outputStatus = await formatterExit;
clearTimeout(drainDeadline);
process.exitCode = startupFailed ? 1 : nativeStatus !== 0 ? nativeStatus : failed ? 1 : outputStatus;
