import { it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

it("re-arms the module abort signal for a replacement session", () => {
  const testApi = (subagentsModule as any).__test__;
  testApi.ensureModuleAbortController();
  const before = testApi.getModuleAbortSignal();

  testApi.abortModulePolls("session_shutdown:new");
  assert.equal(before.aborted, true);
  assert.equal(before.reason, "session_shutdown:new");

  testApi.ensureModuleAbortController();
  const after = testApi.getModuleAbortSignal();

  assert.notEqual(after, before);
  assert.equal(after.aborted, false);
});
