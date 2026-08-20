import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import assert from "node:assert/strict";
import {
  PI_TIMEOUT,
  cleanupTestEnv,
  createTestEnv,
  createTrackedSurface,
  restoreBackend,
  setBackend,
  sleep,
  startPi,
  trackTempFile,
  uniqueId,
  waitForFile,
} from "./harness.ts";

const liveEnabled = process.env.PI_TEST_HERDR_BLOCKED_LIVE === "1";

function paneStatus(paneId: string): string {
  const raw = execFileSync("herdr", ["pane", "get", paneId], { encoding: "utf8" });
  const response = JSON.parse(raw);
  return response.result.pane.agent_status;
}

async function waitForPaneStatus(
  paneId: string,
  predicate: (status: string) => boolean,
  timeout = PI_TIMEOUT,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - startedAt < timeout) {
    lastStatus = paneStatus(paneId);
    if (predicate(lastStatus)) return lastStatus;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for Herdr pane ${paneId} status; last status: ${lastStatus}`);
}

it(
  "shows a settled parent as blocked until its final child exits",
  { skip: !liveEnabled, timeout: PI_TIMEOUT * 3 },
  async () => {
    const managedIntegration = join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts");
    assert.equal(existsSync(managedIntegration), true, "Herdr's managed Pi integration must be installed");
    assert.match(
      execFileSync("herdr", ["integration", "status"], { encoding: "utf8" }),
      /^pi: current \(v8\)/m,
    );

    const previousBackend = setBackend("herdr");
    const env = createTestEnv("herdr");
    const id = uniqueId();
    const startedFile = `/tmp/pi-integ-herdr-blocked-started-${id}.txt`;
    const finishedFile = `/tmp/pi-integ-herdr-blocked-finished-${id}.txt`;
    trackTempFile(env, startedFile);
    trackTempFile(env, finishedFile);

    try {
      const parentPane = await createTrackedSurface(env, `herdr-blocked-${id}`);
      await sleep(1000);
      const task = [
        "Call the subagent tool exactly once with:",
        `  name: "HerdrBlocked-${id}"`,
        '  agent: "test-echo"',
        '  model: "github-copilot/claude-haiku-4.5"',
        `  task: "Run: echo started > '${startedFile}'; sleep 20; echo finished > '${finishedFile}'"`,
        "After the tool acknowledges launch, end your turn and wait for its automatic result.",
      ].join("\n");

      await startPi(parentPane, env.dir, task, {
        model: process.env.PI_TEST_MODEL ?? "github-copilot/claude-haiku-4.5",
        extraArgs: `-e ${managedIntegration}`,
      });

      await waitForFile(startedFile, PI_TIMEOUT, /started/);
      assert.equal(await waitForPaneStatus(parentPane, (status) => status === "blocked"), "blocked");

      await waitForFile(finishedFile, PI_TIMEOUT, /finished/);
      assert.notEqual(
        await waitForPaneStatus(parentPane, (status) => status !== "blocked"),
        "blocked",
      );
    } finally {
      await cleanupTestEnv(env);
      restoreBackend(previousBackend);
    }
  },
);
