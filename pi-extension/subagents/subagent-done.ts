/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { createSubagentActivityRecorder } from "./activity.ts";
import { createChildCompletionRecorder } from "./completion.ts";
import { getDirectChildCount, setDirectChildCountObserver } from "./ownership.ts";
import {
  buildSkillBootstrappedInput,
  buildSkillBootstrappedInputFromSnapshots,
} from "./skill-bootstrap.ts";
import {
  RESUME_POLICY_CUSTOM_TYPE,
  RESUME_POLICY_ENV,
  RESUME_POLICY_RESTORE_ENV,
  createResumePolicy,
  parseLaunchPolicySeed,
  readResumePolicy,
  type LaunchPolicySeed,
  type ResumePolicy,
} from "./resume-policy.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentSettled(
  userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  if (userTookOver) return false;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") return msg.stopReason !== "aborted";
    }
  }
  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentSettled).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const launchPolicyValue = process.env[RESUME_POLICY_ENV];
  const restoreResumePolicy = process.env[RESUME_POLICY_RESTORE_ENV] === "1";
  delete process.env[RESUME_POLICY_ENV];
  delete process.env[RESUME_POLICY_RESTORE_ENV];
  const runId = process.env.PI_SUBAGENT_ID;
  const snapshotFile = process.env.PI_SUBAGENT_COMPLETION_FILE;
  const sessionFile = process.env.PI_SUBAGENT_SESSION;
  if (!runId || !snapshotFile || !sessionFile) {
    throw new Error(
      "subagent completion requires PI_SUBAGENT_ID, PI_SUBAGENT_COMPLETION_FILE, and PI_SUBAGENT_SESSION",
    );
  }
  const completionRecorder = createChildCompletionRecorder({
    runId,
    snapshotFile,
    sessionFile,
    childPid: process.pid,
  });
  let launchPolicySeed: LaunchPolicySeed | null = null;
  let resumePolicy: ResumePolicy | null = null;
  let startupPolicyError: string | null = null;
  try {
    if (launchPolicyValue && restoreResumePolicy) {
      throw new Error("cannot combine fresh and resumed policy authority");
    }
    launchPolicySeed = launchPolicyValue ? parseLaunchPolicySeed(launchPolicyValue) : null;
    resumePolicy = restoreResumePolicy ? readResumePolicy(sessionFile) : null;
  } catch (error) {
    startupPolicyError = `Unable to restore subagent policy: ${error instanceof Error ? error.message : String(error)}`;
  }
  const recorder = createSubagentActivityRecorder({
    runningChildId: runId,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });
  setDirectChildCountObserver((count) => recorder.directChildCount(count));

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let latestMessages: any[] | undefined;
  let explicitCompletionRequested = false;
  let skillBootstrapApplied = false;

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    if (startupPolicyError) {
      explicitCompletionRequested = true;
      completionRecorder.record(
        { kind: "completion-requested", reason: "agent-error" },
        { kind: "error", errorMessage: startupPolicyError, stopReason: "error" },
      );
      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    completionRecorder.record({ kind: "progress", activity: "session-start", estimated: false });
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", (event, ctx) => {
    recorder.input();
    if (!skillBootstrapApplied && (launchPolicySeed || resumePolicy)) {
      const result = launchPolicySeed
        ? buildSkillBootstrappedInput({
            input: event.text,
            requestedNames: launchPolicySeed.requestedSkills,
            commands: pi.getCommands(),
            readSkill: (path) => readFileSync(path, "utf8"),
          })
        : {
            ok: true as const,
            ...buildSkillBootstrappedInputFromSnapshots({
              input: event.text,
              skills: resumePolicy!.skills,
            }),
            skills: resumePolicy!.skills,
          };
      if (!result.ok) {
        explicitCompletionRequested = true;
        completionRecorder.record(
          { kind: "completion-requested", reason: "agent-error" },
          { kind: "error", errorMessage: result.diagnostic.message, stopReason: "error" },
        );
        recorder.agentEndDone();
        ctx.shutdown();
        return { action: "handled" as const };
      }

      if (launchPolicySeed) {
        pi.appendEntry(
          RESUME_POLICY_CUSTOM_TYPE,
          createResumePolicy(
            launchPolicySeed,
            ctx.sessionManager.getSessionId(),
            pi.getActiveTools(),
            result.skills,
          ),
        );
      }
      skillBootstrapApplied = true;
      if (result.text !== event.text) {
        return {
          action: "transform" as const,
          text: result.text,
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      }
      return { action: "continue" as const };
    }

    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    completionRecorder.record({ kind: "progress", activity: "agent-start", estimated: false });
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    latestMessages = (event as any).messages as any[] | undefined;
    completionRecorder.record({ kind: "agent-ended" });
    recorder.agentEndWaiting();
  });

  pi.on("agent_settled", (_event, ctx) => {
    completionRecorder.record({ kind: "agent-settled" });
    if (
      explicitCompletionRequested ||
      !autoExit ||
      getDirectChildCount() > 0 ||
      !shouldAutoExitOnAgentSettled(userTookOver, latestMessages)
    ) {
      return;
    }

    const errorInfo = findLatestAssistantError(latestMessages);
    explicitCompletionRequested = true;
    if (errorInfo) {
      completionRecorder.record(
        { kind: "completion-requested", reason: "agent-error" },
        { kind: "error", ...errorInfo },
      );
    } else {
      completionRecorder.record({ kind: "completion-requested", reason: "auto-exit" }, { kind: "done" });
    }
    recorder.agentEndDone();
    ctx.shutdown();
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    const reason = (event as any).reason;
    completionRecorder.record({ kind: "session-shutdown", reason });
    recorder.sessionShutdown(reason);
    setDirectChildCountObserver(null);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const directChildCount = getDirectChildCount();
      if (directChildCount > 0) {
        return {
          content: [{
            type: "text",
            text: `Cannot exit while ${directChildCount} directly owned subagent${directChildCount === 1 ? " is" : "s are"} still running. Wait for or terminate them first.`,
          }],
          details: { error: "owned-subagents-active", count: directChildCount },
        };
      }

      const payload = {
        kind: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      completionRecorder.record({ kind: "completion-requested", reason: "ping" }, payload);
      explicitCompletionRequested = true;
      recorder.callerPing();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const directChildCount = getDirectChildCount();
      if (directChildCount > 0) {
        return {
          content: [{
            type: "text",
            text: `Cannot exit while ${directChildCount} directly owned subagent${directChildCount === 1 ? " is" : "s are"} still running. Wait for or terminate them first.`,
          }],
          details: { error: "owned-subagents-active", count: directChildCount },
        };
      }

      completionRecorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
      explicitCompletionRequested = true;
      recorder.subagentDone();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
        terminate: true,
      };
    },
  });
}
