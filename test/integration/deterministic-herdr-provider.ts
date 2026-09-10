import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("deterministic provider requires PI_CODING_AGENT_DIR");
const config = JSON.parse(readFileSync(join(agentDir, "extensions", "deterministic-herdr-config.json"), "utf8"));
const { eventsFile, gateFile, releaseFile, versionsFile } = config;

function record(event: string, details: Record<string, unknown> = {}) {
  appendFileSync(eventsFile, `${JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid, subagentId: process.env.PI_SUBAGENT_ID ?? null, ...details })}\n`);
}

function snapshot() {
  const file = process.env.PI_SUBAGENT_COMPLETION_FILE;
  return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

async function waitForRelease() {
  const deadline = Date.now() + 60_000;
  while (!existsSync(releaseFile)) {
    if (Date.now() > deadline) throw new Error("deterministic completion gate timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export default function (pi: any) {
  let parentProviderCalls = 0;
  pi.on("session_start", () => {
    const entrypoint = process.argv[1];
    if (!entrypoint || entrypoint.endsWith("deterministic-herdr-provider.ts")) throw new Error(`invalid Pi entrypoint: ${entrypoint ?? "missing"}`);
    const version = spawnSync(process.execPath, [entrypoint, "--version"], { encoding: "utf8", timeout: 5000 });
    if (version.status !== 0 || version.signal || version.error) throw new Error(`Pi version probe failed: ${version.error ?? version.stderr}`);
    appendFileSync(versionsFile, `${JSON.stringify({ pid: process.pid, execPath: process.execPath, entrypoint, version: version.stdout.trim(), subagentId: process.env.PI_SUBAGENT_ID ?? null })}\n`);
    record("session_start");
  });
  pi.on("agent_settled", () => record("agent_settled", { snapshot: snapshot() }));
  pi.on("session_shutdown", (event: any) => record("session_shutdown", { reason: event.reason, snapshot: snapshot() }));
  pi.on("tool_result", async (event: any) => {
    if (process.env.PI_SUBAGENT_ID && event.toolName === "subagent_done") {
      record("child_done_tool_result_gate", {
        processAlive: (() => { try { process.kill(process.pid, 0); return true; } catch { return false; } })(),
        snapshot: snapshot(),
      });
      appendFileSync(gateFile, "ready\n");
      await waitForRelease();
      record("child_done_tool_result_released");
    } else if (!process.env.PI_SUBAGENT_ID && event.toolName === "subagent") {
      record("parent_subagent_tool_result", { result: event.result });
    }
  });

  pi.registerProvider("deterministic-herdr", {
    name: "Deterministic Herdr",
    baseUrl: "http://127.0.0.1/unused",
    apiKey: "offline-test-only",
    api: "openai-completions",
    models: [{ id: "probe", name: "Probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream();
      const child = Boolean(process.env.PI_SUBAGENT_ID);
      const hasToolResult = context.messages.some((message: any) => message.role === "toolResult");
      if (!child) parentProviderCalls++;
      const hasParentResult = !child && parentProviderCalls >= 3;
      if (hasParentResult) record("parent_result_observed");
      record("provider_invoked", { child, hasToolResult, hasParentResult });
      queueMicrotask(() => {
        const output: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: hasToolResult ? "stop" : "toolUse", timestamp: Date.now() };
        stream.push({ type: "start", partial: output });
        const text = hasToolResult ? (child ? "CHILD_POST_TOOL_STOP" : "PARENT_RECEIVED_RESULT") : (child ? "CHILD_COMPLETION_SUMMARY" : "PARENT_LAUNCHING_CHILD");
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        if (!hasToolResult) {
          const toolCall = child
            ? { type: "toolCall", id: "done-1", name: "subagent_done", arguments: {} }
            : { type: "toolCall", id: "spawn-1", name: "subagent", arguments: { name: "DeterministicChild", agent: "deterministic-child", task: "Call subagent_done exactly once." } };
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
}
