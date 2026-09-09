import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const { parseVisibleAgentDefinition, resolveVisibleLaunchIntent } = (subagentsModule as any).__test__;

describe("visible system prompt configuration", () => {
  it("preserves explicit replace and append routing", () => {
    for (const mode of ["replace", "append"] as const) {
      const parsed = parseVisibleAgentDefinition(
        `/tmp/${mode}.md`,
        `---\nsystem-prompt: ${mode}\n---\n\nYou are a specialized agent.`,
      );
      assert.ok(parsed);
      assert.equal(parsed.systemPromptMode, mode);
      assert.equal(parsed.body, "You are a specialized agent.");
      assert.deepEqual(
        resolveVisibleLaunchIntent({ name: "Agent", task: "work" }, parsed, "/caller").effective.systemPrompt,
        { mode, text: "You are a specialized agent." },
      );
    }
  });

  it("preserves an explicit empty-body prompt mode", () => {
    const parsed = parseVisibleAgentDefinition(
      "/tmp/empty.md",
      "---\nsystem-prompt: replace\n---\n",
    );
    assert.ok(parsed);
    assert.equal(parsed.systemPromptMode, "replace");
    assert.equal(parsed.body, undefined);
    assert.deepEqual(
      resolveVisibleLaunchIntent({ name: "Agent", task: "work" }, parsed, "/caller").effective.systemPrompt,
      { mode: "replace", text: "" },
    );
  });

  it("keeps an implicit body in task-routing mode", () => {
    const parsed = parseVisibleAgentDefinition(
      "/tmp/default.md",
      "---\nmodel: anthropic/test\n---\n\nYou are a default agent.",
    );
    assert.ok(parsed);
    assert.equal(parsed.systemPromptMode, undefined);
    assert.equal(parsed.body, "You are a default agent.");
  });
});
