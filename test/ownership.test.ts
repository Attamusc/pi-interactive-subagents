import { it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

it("requests closure and releases every directly owned child during session shutdown", async () => {
  const testApi = (subagentsModule as any).__test__;
  const events: Array<{ channel: string; data: unknown }> = [];
  const pi = { events: { emit(channel: string, data: unknown) { events.push({ channel, data }); } } };
  const aborted: string[] = [];
  const closed: string[] = [];
  testApi.runningSubagents.clear();

  const makeRunning = (id: string, surface: string) => ({
    id,
    name: id,
    surface,
    abortController: { abort(reason: string) { aborted.push(reason); } },
  });

  testApi.registerRunningSubagent(pi, makeRunning("shutdown-child-1", "shutdown-pane-1"));
  testApi.registerRunningSubagent(pi, makeRunning("shutdown-child-2", "shutdown-pane-2"));
  const failures = await testApi.shutdownOwnedSubagents(
    "quit",
    async (surface: string) => { closed.push(surface); },
  );

  assert.deepEqual(failures, []);
  assert.deepEqual(aborted, ["session_shutdown:quit", "session_shutdown:quit"]);
  assert.deepEqual(closed.sort(), ["shutdown-pane-1", "shutdown-pane-2"]);
  assert.equal(testApi.runningSubagents.size, 0);
  assert.deepEqual(events, [
    { channel: "herdr:blocked", data: { active: true, label: "waiting on subagent" } },
    { channel: "herdr:blocked", data: { active: true, label: "waiting on subagent" } },
    { channel: "herdr:blocked", data: { active: false } },
    { channel: "herdr:blocked", data: { active: false } },
  ]);
});
