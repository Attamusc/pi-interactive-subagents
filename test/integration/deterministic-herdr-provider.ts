import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("deterministic provider requires PI_CODING_AGENT_DIR");
const config = JSON.parse(readFileSync(join(agentDir, "extensions", "deterministic-herdr-config.json"), "utf8"));
const { eventsFile, gateFile, releaseFile, versionsFile, scenario = "completion", childName = "DeterministicChild", siblingReleaseFile, invalidSessionFile, fixtureToolCallId, missingSkillAgent } = config;

function record(event: string, details: Record<string, unknown> = {}) {
  appendFileSync(eventsFile, `${JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid, subagentId: process.env.PI_SUBAGENT_ID ?? null, subagentName: process.env.PI_SUBAGENT_NAME ?? null, ...details })}\n`);
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
  pi.on("session_start", (_event: any, ctx: any) => {
    const entrypoint = process.argv[1];
    if (!entrypoint || entrypoint.endsWith("deterministic-herdr-provider.ts")) throw new Error(`invalid Pi entrypoint: ${entrypoint ?? "missing"}`);
    const version = spawnSync(process.execPath, [entrypoint, "--version"], { encoding: "utf8", timeout: 5000 });
    if (version.status !== 0 || version.signal || version.error) throw new Error(`Pi version probe failed: ${version.error ?? version.stderr}`);
    appendFileSync(versionsFile, `${JSON.stringify({ pid: process.pid, execPath: process.execPath, entrypoint, version: version.stdout.trim(), subagentId: process.env.PI_SUBAGENT_ID ?? null })}\n`);
    record("session_start", {
      sessionFile: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
      agent: process.env.PI_SUBAGENT_AGENT ?? null,
      deniedTools: process.env.PI_DENY_TOOLS ?? null,
      activeTools: pi.getActiveTools(),
    });
  });
  pi.on("before_agent_start", (event: any) => {
    record("before_agent_start", { systemPrompt: event.systemPrompt });
  });
  pi.on("agent_settled", () => record("agent_settled", { snapshot: snapshot() }));
  pi.on("session_shutdown", (event: any) => record("session_shutdown", { reason: event.reason, snapshot: snapshot() }));
  pi.on("tool_execution_start", (event: any) => {
    const activityFile = process.env.PI_SUBAGENT_ACTIVITY_FILE;
    record("tool_execution_start", {
      rawToolCallId: event.toolCallId,
      activity: activityFile && existsSync(activityFile) ? JSON.parse(readFileSync(activityFile, "utf8")) : null,
    });
  });
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
    streamSimple(model: any, context: any, options: any = {}) {
      const stream = createAssistantMessageEventStream();
      const child = Boolean(process.env.PI_SUBAGENT_ID);
      const latest = context.messages.at(-1);
      const hasToolResult = context.messages.some((message: any) => message.role === "toolResult");
      const requestMessages = context.messages.map((message: any) => ({
        role: message.role,
        content: typeof message.content === "string"
          ? message.content
          : message.content?.map((part: any) => part.type === "text"
            ? { type: "text", text: part.text }
            : part.type === "toolCall"
              ? { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments }
              : part),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      }));
      record("provider_invoked", { child, hasToolResult, requestMessages });

      const output: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "pending", timestamp: Date.now() };
      const heldChild = child && (
        scenario === "control" ||
        (scenario === "siblings" && process.env.PI_SUBAGENT_NAME !== "ResumedA") ||
        (scenario === "nested" && process.env.PI_SUBAGENT_NAME === "Grandchild")
      );
      if (heldChild) {
        if (!options.signal) throw new Error("deterministic held stream requires Pi AbortSignal");
        queueMicrotask(async () => {
          stream.push({ type: "start", partial: output });
          record("child_stream_held");
          let finished = false;
          const abort = () => {
            if (finished) return;
            finished = true;
            output.stopReason = "aborted";
            output.errorMessage = "Request was aborted";
            output.timestamp = Date.now();
            record("child_stream_aborted");
            stream.push({ type: "error", reason: "aborted", error: output });
            stream.end(output);
          };
          if (options.signal.aborted) return abort();
          options.signal.addEventListener("abort", abort, { once: true });
          const releaseHeldChild =
            (scenario === "siblings" && process.env.PI_SUBAGENT_NAME === "SiblingB") ||
            (scenario === "nested" && process.env.PI_SUBAGENT_NAME === "Grandchild");
          if (releaseHeldChild) {
            while (!finished && !existsSync(siblingReleaseFile)) await new Promise(resolve => setTimeout(resolve, 25));
            if (!finished) {
              finished = true;
              options.signal.removeEventListener("abort", abort);
              const releasedText = scenario === "nested" ? "GRANDCHILD_RELEASED" : "SIBLING_B_RELEASED";
              output.stopReason = "stop";
              output.content.push({ type: "text", text: releasedText });
              record("child_stream_released");
              stream.push({ type: "text_start", contentIndex: 0, partial: output });
              stream.push({ type: "text_delta", contentIndex: 0, delta: releasedText, partial: output });
              stream.push({ type: "text_end", contentIndex: 0, content: releasedText, partial: output });
              stream.push({ type: "done", reason: "stop", message: output });
              stream.end(output);
            }
          }
        });
        return stream;
      }

      queueMicrotask(() => {
        const latestUserText = latest?.role === "user"
          ? (typeof latest.content === "string" ? latest.content : latest.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join(""))
          : undefined;
        const controlTool = scenario === "control" && latestUserText === "fixture interrupt" ? "subagent_interrupt"
          : scenario === "control" && latestUserText === "fixture terminate" ? "subagent_terminate"
          : scenario === "siblings" && latestUserText === "fixture interrupt A" ? "subagent_interrupt"
          : scenario === "siblings" && latestUserText === "fixture terminate A" ? "subagent_terminate"
          : scenario === "siblings" && latestUserText === "fixture resume A" ? "subagent_resume"
          : scenario === "nested" && latestUserText === "fixture ancestor terminate grandchild" ? "subagent_terminate"
          : scenario === "nested" && latestUserText === "fixture terminate orchestrator" ? "subagent_terminate"
          : scenario === "nested" && latestUserText === "fixture invalid resume" ? "subagent_resume" : undefined;
        const initialControl = scenario === "control" && !hasToolResult && !controlTool;
        const initialMissing = scenario === "missing-skill" && !hasToolResult && !child;
        const plannerDraft = scenario === "planner" && child && !hasToolResult && latestUserText !== "fixture approve plan";
        const plannerFinal = scenario === "planner" && child && latestUserText === "fixture approve plan";
        const initialSiblings = scenario === "siblings" && !hasToolResult && !controlTool && !child;
        const initialNestedRoot = scenario === "nested" && !hasToolResult && !controlTool && !child;
        const initialNestedOrchestrator = scenario === "nested" && !hasToolResult && !controlTool && process.env.PI_SUBAGENT_NAME === "Orchestrator";
        output.stopReason = hasToolResult && !controlTool ? "stop" : plannerDraft ? "stop" : "toolUse";
        stream.push({ type: "start", partial: output });
        const text = plannerDraft ? "PLANNER_DRAFT_WAITING_FOR_APPROVAL"
          : plannerFinal ? "PLANNER_FINAL_SUMMARY"
          : scenario === "siblings" && child ? "RESUMED_A_FRESH_RESULT"
          : scenario === "nested" && process.env.PI_SUBAGENT_NAME === "Orchestrator" && hasToolResult ? "ORCHESTRATOR_WAITING_FOR_CHILD"
          : hasToolResult && !controlTool ? (child ? "CHILD_POST_TOOL_STOP" : "PARENT_RECEIVED_RESULT") : (child ? "CHILD_COMPLETION_SUMMARY" : "PARENT_LAUNCHING_CHILD");
        output.content.push({ type: "text", text });
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        if (plannerDraft) {
          // Deliberately settle without completing: the interactive planner remains open.
        } else if (initialSiblings) {
          const calls = [
            { type: "toolCall", id: "spawn-a", name: "subagent", arguments: { name: "SiblingA", agent: "deterministic-held-child", task: "hold sibling A" } },
            { type: "toolCall", id: "spawn-b", name: "subagent", arguments: { name: "SiblingB", agent: "deterministic-auto-child", task: "hold sibling B until release" } },
          ];
          calls.forEach((toolCall, index) => {
            output.content.push(toolCall);
            stream.push({ type: "toolcall_start", contentIndex: index + 1, partial: output });
            stream.push({ type: "toolcall_end", contentIndex: index + 1, toolCall, partial: output });
          });
        } else if (initialNestedRoot || initialNestedOrchestrator || !hasToolResult || controlTool || plannerFinal) {
          const terminated = [...context.messages].reverse().find((message: any) => message.role === "toolResult" && message.toolName === "subagent_terminate");
          const nestedControlName = latestUserText === "fixture ancestor terminate grandchild" ? "Grandchild" : "Orchestrator";
          const controlCallId = scenario === "nested"
            ? controlTool === "subagent_resume" ? "invalid-resume" : nestedControlName === "Grandchild" ? "terminate-grandchild" : "terminate-orchestrator"
            : `${controlTool}-1`;
          const toolCall = controlTool === "subagent_resume"
            ? scenario === "nested"
              ? { type: "toolCall", id: controlCallId, name: controlTool, arguments: { sessionPath: invalidSessionFile, name: "Untrusted resume", autoExit: true } }
              : { type: "toolCall", id: "resume-a", name: controlTool, arguments: { sessionPath: terminated?.details?.sessionFile, name: "ResumedA", message: "produce the fresh resumed fixture result", autoExit: true } }
            : controlTool
              ? { type: "toolCall", id: controlCallId, name: controlTool, arguments: { name: scenario === "siblings" ? "SiblingA" : scenario === "nested" ? nestedControlName : childName } }
              : initialNestedRoot
                ? { type: "toolCall", id: "spawn-orchestrator", name: "subagent", arguments: { name: "Orchestrator", agent: "deterministic-orchestrator", task: "Launch and wait for the grandchild." } }
                : initialNestedOrchestrator
                  ? { type: "toolCall", id: "spawn-grandchild", name: "subagent", arguments: { name: "Grandchild", agent: "deterministic-grandchild", task: "Hold until released." } }
                  : initialControl
                    ? { type: "toolCall", id: "spawn-1", name: "subagent", arguments: { name: childName, agent: "deterministic-child", task: "hold for control test" } }
                    : initialMissing
                      ? { type: "toolCall", id: "spawn-missing", name: "subagent", arguments: missingSkillAgent
                        ? { name: childName, agent: missingSkillAgent, task: "This artifact request must fail before provider work." }
                        : { name: childName, task: "This direct request must fail before provider work.", skills: "missing-live-skill", fork: true } }
                      : child
                        ? { type: "toolCall", id: fixtureToolCallId ?? "done-1", name: "subagent_done", arguments: {} }
                        : { type: "toolCall", id: "spawn-1", name: "subagent", arguments: { name: childName, agent: scenario === "planner" ? "deterministic-planner" : "deterministic-child", task: scenario === "planner" ? "Draft a plan, wait for approval, then finalize." : "Call subagent_done exactly once." } };
          record("provider_emitted_tool_call", { child, toolCallId: toolCall.id, toolName: toolCall.name, toolCallArguments: toolCall.arguments });
          output.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
          stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: output });
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end(output);
      });
      return stream;
    },
  });
}
