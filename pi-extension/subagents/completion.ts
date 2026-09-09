/**
 * Pure/filesystem protocol seams for visible child completion. Integration code
 * supplies owned paths and lifecycle observations; this module never watches,
 * schedules, starts a process, or calls Pi lifecycle APIs.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAgentRunState,
  projectAgentRunStatus,
  reduceAgentRunEvidence,
  type AgentRunEvidence,
  type AgentRunState,
  type CompletionReason,
} from "pi-agent-execution";

const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_FACTS = 16;
const MAX_STRING = 4096;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const FACT_KINDS = new Set(["completion-requested", "agent-ended", "agent-settled", "session-shutdown", "progress"]);

export type ChildCompletionFact = Extract<AgentRunEvidence, { kind: "completion-requested" | "agent-ended" | "agent-settled" | "session-shutdown" | "progress" }>;
export type ChildCompletionFactInput =
  | { kind: "completion-requested"; reason: CompletionReason }
  | { kind: "agent-ended"; willRetry?: boolean }
  | { kind: "agent-settled" }
  | { kind: "session-shutdown"; reason: string }
  | { kind: "progress"; activity?: string; estimated: boolean };

export interface ChildCompletionSnapshot {
  version: 1;
  runId: string;
  sourceId: string;
  sequence: number;
  observedAt: string;
  childPid: number;
  sessionFile: string;
  done?: unknown;
  ping?: unknown;
  latestFacts: ChildCompletionFact[];
}

export interface WrapperExitRecord {
  version: 1;
  runId: string;
  sourceId: string;
  sequence: 1;
  observedAt: string;
  exit: { kind: "shell"; shellStatus: number };
}

export type SidecarReadResult<T> = { ok: true; value: T } | { ok: false; reason: "missing" | "invalid" | "wrong-id" | "stale"; error?: string };

export function buildVisibleCompletionPaths(artifactDir: string, runId: string) {
  requireRunId(runId);
  const dir = join(artifactDir, "subagent-completion");
  return { childSnapshot: join(dir, `${runId}.child.json`), wrapperExit: join(dir, `${runId}.wrapper.json`) };
}

function requireRunId(runId: string): void {
  if (!RUN_ID.test(runId) || runId === "." || runId === "..") throw new Error("runId contains unsafe path characters");
}

function atomicWrite(file: string, value: unknown, sequence: number): void {
  const body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > MAX_SIDECAR_BYTES) throw new Error("sidecar exceeds maximum size");
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${sequence}.tmp`;
  try {
    writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function boundedPayload(value: unknown): boolean {
  if (value === undefined) return true;
  try { return Buffer.byteLength(JSON.stringify(value)) <= MAX_STRING; } catch { return false; }
}

function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING; }
function validInteger(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
function validDate(value: unknown): value is string { return validString(value) && Number.isFinite(Date.parse(value)); }
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }

function validateFact(value: unknown, runId: string, sourceId: string): value is ChildCompletionFact {
  const fact = object(value);
  if (!fact || !FACT_KINDS.has(String(fact.kind)) || fact.runId !== runId || fact.sourceId !== sourceId || !validInteger(fact.sequence, 1) || !validDate(fact.observedAt)) return false;
  if (fact.kind === "completion-requested") return ["done", "auto-exit", "ping", "agent-error"].includes(String(fact.reason));
  if (fact.kind === "agent-ended") return fact.willRetry === undefined || typeof fact.willRetry === "boolean";
  if (fact.kind === "agent-settled") return true;
  if (fact.kind === "session-shutdown") return validString(fact.reason);
  return typeof fact.estimated === "boolean" && (fact.activity === undefined || validString(fact.activity));
}

export function createChildCompletionRecorder(params: { runId: string; childPid: number; sessionFile: string; snapshotFile: string; now?: () => string; done?: unknown; ping?: unknown }) {
  requireRunId(params.runId);
  if (!validInteger(params.childPid, 1)) throw new Error("childPid must be a positive integer");
  if (!validString(params.sessionFile)) throw new Error("sessionFile is invalid");
  if (!boundedPayload(params.done) || !boundedPayload(params.ping)) throw new Error("payload is too large or not serializable");
  let sequence = 0;
  let facts: ChildCompletionFact[] = [];
  const now = params.now ?? (() => new Date().toISOString());
  return {
    record(input: ChildCompletionFactInput): ChildCompletionSnapshot {
      const observedAt = now();
      if (!validDate(observedAt)) throw new Error("now returned an invalid timestamp");
      sequence++;
      const fact = { ...input, runId: params.runId, sourceId: `pi-child:${params.runId}`, sequence, observedAt } as ChildCompletionFact;
      if (!validateFact(fact, params.runId, fact.sourceId)) throw new Error("invalid completion fact");
      // Retain the newest observation of each kind so frequent progress cannot
      // evict rarer completion/settlement evidence from the bounded snapshot.
      facts = [...facts.filter(previous => previous.kind !== fact.kind), fact].slice(-MAX_FACTS);
      const snapshot: ChildCompletionSnapshot = { version: 1, runId: params.runId, sourceId: fact.sourceId, sequence, observedAt, childPid: params.childPid, sessionFile: params.sessionFile, ...(params.done === undefined ? {} : { done: params.done }), ...(params.ping === undefined ? {} : { ping: params.ping }), latestFacts: facts };
      atomicWrite(params.snapshotFile, snapshot, sequence);
      return snapshot;
    },
  };
}

function readJson(file: string): SidecarReadResult<unknown> {
  if (!existsSync(file)) return { ok: false, reason: "missing" };
  try {
    if (statSync(file).size > MAX_SIDECAR_BYTES) return { ok: false, reason: "invalid", error: "sidecar exceeds maximum size" };
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) { return { ok: false, reason: "invalid", error: error instanceof Error ? error.message : String(error) }; }
}

export type ChildSnapshotReadResult =
  | { ok: true; snapshot: ChildCompletionSnapshot; state: AgentRunState; terminal: boolean }
  | { ok: false; reason: "missing" | "invalid" | "wrong-id" | "stale"; error?: string };

export function readChildCompletionSnapshot(file: string, expectedRunId: string, afterSequence = 0): ChildSnapshotReadResult {
  const read = readJson(file); if (!read.ok) return read;
  const value = object(read.value);
  if (!value || value.version !== 1) return { ok: false, reason: "invalid", error: "unsupported snapshot shape or version" };
  if (value.runId !== expectedRunId || value.sourceId !== `pi-child:${expectedRunId}`) return { ok: false, reason: "wrong-id" };
  if (!validInteger(value.sequence, 1) || !validDate(value.observedAt) || !validInteger(value.childPid, 1) || !validString(value.sessionFile) || !Array.isArray(value.latestFacts) || value.latestFacts.length > MAX_FACTS || !boundedPayload(value.done) || !boundedPayload(value.ping)) return { ok: false, reason: "invalid", error: "invalid snapshot fields" };
  if (value.sequence <= afterSequence) return { ok: false, reason: "stale" };
  if (!value.latestFacts.every(f => validateFact(f, expectedRunId, String(value.sourceId)))) return { ok: false, reason: "invalid", error: "invalid lifecycle fact" };
  const sequences = value.latestFacts.map(f => (f as ChildCompletionFact).sequence);
  if (new Set(sequences).size !== sequences.length || sequences.some((n, i) => i > 0 && n <= sequences[i - 1]!) || sequences.some(n => n > value.sequence!)) return { ok: false, reason: "invalid", error: "fact sequences are not monotonic" };
  const snapshot = value as unknown as ChildCompletionSnapshot;
  let state = createAgentRunState(expectedRunId);
  for (const fact of snapshot.latestFacts) state = reduceAgentRunEvidence(state, fact);
  return { ok: true, snapshot, state, terminal: projectAgentRunStatus(state).terminal };
}

export function readWrapperExitRecord(file: string, expectedRunId: string, afterSequence = 0): SidecarReadResult<WrapperExitRecord> & { record?: WrapperExitRecord } {
  const read = readJson(file); if (!read.ok) return read;
  const value = object(read.value); const exit = object(value?.exit);
  if (!value || value.version !== 1) return { ok: false, reason: "invalid", error: "unsupported wrapper shape or version" };
  if (value.runId !== expectedRunId || value.sourceId !== `wrapper:${expectedRunId}`) return { ok: false, reason: "wrong-id" };
  if (value.sequence !== 1 || !validDate(value.observedAt) || exit?.kind !== "shell" || !validInteger(exit.shellStatus, 0) || (exit.shellStatus as number) > 255) return { ok: false, reason: "invalid", error: "invalid wrapper fields" };
  if (1 <= afterSequence) return { ok: false, reason: "stale" };
  const record = value as unknown as WrapperExitRecord;
  return { ok: true, value: record, record };
}

function shellEscape(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** Builds the existing launch shell's body; it does not spawn or watch a process. */
export function buildVisibleWrapperCommand(params: { piCommand: string; runId: string; wrapperExitFile: string; terminalSentinel?: string }): string {
  requireRunId(params.runId);
  if (!params.piCommand.trim()) throw new Error("piCommand is required");
  const writer = `const fs=require('node:fs'),path=require('node:path');const file=process.argv[1],runId=process.argv[2],status=Number(process.argv[3]);const record={version:1,runId,sourceId:'wrapper:'+runId,sequence:1,observedAt:new Date().toISOString(),exit:{kind:'shell',shellStatus:status}};fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(record)+'\\n',{mode:384,flag:'wx'});fs.chmodSync(temp,384);fs.renameSync(temp,file);`;
  const sentinel = params.terminalSentinel === undefined ? "" : `\nprintf '%s\\n' ${shellEscape(params.terminalSentinel)} >/dev/null`;
  return `${params.piCommand}\n_pi_status=$?\nnode -e ${shellEscape(writer)} ${shellEscape(params.wrapperExitFile)} ${shellEscape(params.runId)} "$_pi_status"\n_pi_record_status=$?${sentinel}\nexit "$_pi_status"`;
}
