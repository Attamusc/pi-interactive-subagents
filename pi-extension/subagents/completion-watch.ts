import {
  createAgentRunState,
  extractLatestAssistantOutput,
  projectAgentRunCompletion,
  projectAgentRunStatus,
  reduceAgentRunEvidence,
  type AgentRunEvidence,
  type AgentRunState,
} from "pi-agent-execution";
import { getNewEntries } from "./session.ts";
import {
  readChildCompletionSnapshot,
  readWrapperExitRecord,
  type CompletionPayload,
} from "./completion.ts";

export interface VisibleCompletionState {
  core: AgentRunState;
  childSequence: number;
  wrapperSequence: number;
  parentSequence: number;
  childPid?: number;
  childSessionFile?: string;
  payload?: CompletionPayload;
  diagnostics: string[];
}

export function createVisibleCompletionState(runId: string): VisibleCompletionState {
  return { core: createAgentRunState(runId), childSequence: 0, wrapperSequence: 0, parentSequence: 0, diagnostics: [] };
}

function diagnostic(state: VisibleCompletionState, source: string, result: { reason: string; error?: string }): void {
  if (result.reason === "missing" || result.reason === "stale") return;
  const message = `${source}: ${result.reason}${result.error ? ` (${result.error})` : ""}`;
  if (state.diagnostics.at(-1) !== message) {
    state.diagnostics.push(message);
    state.diagnostics = state.diagnostics.slice(-8);
  }
}

export function observeVisibleCompletion(params: {
  state: VisibleCompletionState;
  childSnapshotFile: string;
  wrapperExitFile: string;
}): ReturnType<typeof projectAgentRunStatus> {
  const { state } = params;
  const child = readChildCompletionSnapshot(params.childSnapshotFile, state.core.runId, state.childSequence);
  if (child.ok) {
    const identityChanged = state.childPid !== undefined &&
      (state.childPid !== child.value.childPid || state.childSessionFile !== child.value.sessionFile);
    if (identityChanged) {
      diagnostic(state, "child snapshot", { reason: "wrong-id", error: "child process identity changed" });
    } else {
      if (state.childPid === undefined) {
        state.childPid = child.value.childPid;
        state.childSessionFile = child.value.sessionFile;
        state.core = reduceAgentRunEvidence(state.core, {
          kind: "host-started", runId: state.core.runId, sourceId: `parent:${state.core.runId}`,
          sequence: ++state.parentSequence, observedAt: child.value.observedAt, hostRef: String(child.value.childPid),
        });
      }
      for (const fact of child.value.latestFacts) state.core = reduceAgentRunEvidence(state.core, fact);
      state.childSequence = child.value.sequence;
      state.payload = child.value.completionPayload;
    }
  } else diagnostic(state, "child snapshot", child);

  const wrapper = readWrapperExitRecord(params.wrapperExitFile, state.core.runId, state.wrapperSequence);
  if (wrapper.ok) {
    state.core = reduceAgentRunEvidence(state.core, {
      kind: "process-exited", runId: state.core.runId, sourceId: wrapper.value.sourceId,
      sequence: wrapper.value.sequence, observedAt: wrapper.value.observedAt, exit: wrapper.value.exit,
    });
    state.wrapperSequence = wrapper.value.sequence;
  } else diagnostic(state, "wrapper exit", wrapper);
  return projectAgentRunStatus(state.core);
}

export type VisibleControlEvidence =
  | { kind: "interrupt-requested"; mode: "process-abort" | "turn-escape" }
  | { kind: "terminate-requested"; mode: "process-signal" | "herdr-pane-close" }
  | { kind: "process-exited"; exit: { kind: "native"; code: number | null; signal: string | null } | { kind: "shell"; shellStatus: number } | { kind: "process-not-found" } };

export function recordVisibleControl(state: VisibleCompletionState, evidence: VisibleControlEvidence): void {
  state.core = reduceAgentRunEvidence(state.core, {
    ...evidence, runId: state.core.runId, sourceId: `parent:${state.core.runId}`,
    sequence: ++state.parentSequence, observedAt: new Date().toISOString(),
  } as AgentRunEvidence);
}

export function confirmOwnedProcessGone(state: VisibleCompletionState, probe: (pid: number, signal: 0) => void = process.kill): boolean {
  if (state.childPid === undefined) return false;
  try { probe(state.childPid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    recordVisibleControl(state, { kind: "process-exited", exit: { kind: "process-not-found" } });
    return true;
  }
}

export async function waitForVisibleCompletion(params: {
  state: VisibleCompletionState; childSnapshotFile: string; wrapperExitFile: string; sessionFile: string;
  transcriptStartLine: number; sessionRef?: string; signal: AbortSignal; interval?: number; onTick?: () => void;
  canComplete?: () => boolean; processProbe?: (pid: number, signal: 0) => void;
}) {
  for (;;) {
    if (params.signal.aborted) throw new Error(`Aborted while waiting for subagent to finish: ${String(params.signal.reason ?? "no abort reason provided")}`);
    let status;
    try { status = observeVisibleCompletion(params); }
    catch (error) {
      diagnostic(params.state, "completion observer", { reason: "invalid", error: error instanceof Error ? error.message : String(error) });
      status = projectAgentRunStatus(params.state.core);
    }
    if (params.state.core.control.status === "terminate-requested") {
      confirmOwnedProcessGone(params.state, params.processProbe);
      status = projectAgentRunStatus(params.state.core);
    }
    if (status.terminal && (params.canComplete?.() ?? true)) {
      let entries: ReturnType<typeof getNewEntries> = [];
      try { entries = getNewEntries(params.sessionFile, params.transcriptStartLine); } catch {}
      const assistant = extractLatestAssistantOutput(entries);
      const payloadError = params.state.payload?.kind === "error" ? params.state.payload.errorMessage : undefined;
      const completion = projectAgentRunCompletion(params.state.core, {
        output: assistant.output,
        errorMessage: payloadError ?? assistant.errorMessage,
        sessionRef: params.sessionRef,
      });
      if (!completion) throw new Error("terminal lifecycle projection produced no completion");
      return { completion, payload: params.state.payload };
    }
    try { params.onTick?.(); }
    catch (error) { diagnostic(params.state, "observer callback", { reason: "invalid", error: error instanceof Error ? error.message : String(error) }); }
    if (params.signal.aborted) throw new Error(`Aborted while waiting for subagent to finish: ${String(params.signal.reason ?? "no abort reason provided")}`);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error(`Aborted while waiting for subagent to finish: ${String(params.signal.reason ?? "no abort reason provided")}`));
      };
      const timer = setTimeout(() => {
        params.signal.removeEventListener("abort", onAbort);
        resolve();
      }, params.interval ?? 1000);
      params.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
