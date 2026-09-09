/**
 * Filesystem protocol seams for visible child completion. Integration supplies
 * owned paths and observations, folds `latestFacts` into its existing core run
 * state, and may consume `completionPayload`; this module never watches,
 * schedules, starts a process, or calls Pi lifecycle APIs.
 */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentRunEvidence, CompletionReason } from "pi-agent-execution";

const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_FACTS = 16;
const MAX_STRING = 4096;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const FACT_KINDS = new Set(["completion-requested", "agent-ended", "agent-settled", "session-shutdown", "progress"]);
const COMPLETION_REASONS = new Set<CompletionReason>(["done", "auto-exit", "ping", "agent-error"]);

export type ChildCompletionFact = Extract<AgentRunEvidence, { kind: "completion-requested" | "agent-ended" | "agent-settled" | "session-shutdown" | "progress" }>;
export type ChildCompletionFactInput =
  | { kind: "completion-requested"; reason: CompletionReason }
  | { kind: "agent-ended"; willRetry?: boolean }
  | { kind: "agent-settled" }
  | { kind: "session-shutdown"; reason: string }
  | { kind: "progress"; activity?: string; estimated: boolean };

export type CompletionPayload =
  | { kind: "done" }
  | { kind: "ping"; name: string; message: string }
  | { kind: "error"; errorMessage: string; stopReason: "error" };

export interface ChildCompletionSnapshot {
  version: 1; runId: string; sourceId: string; sequence: number; observedAt: string;
  childPid: number; sessionFile: string; completionPayload?: CompletionPayload;
  latestFacts: ChildCompletionFact[];
}
export interface WrapperExitRecord {
  version: 1; runId: string; sourceId: string; sequence: 1; observedAt: string;
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
  let owned = false;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600); owned = true;
    writeFileSync(fd, body, "utf8"); closeSync(fd); fd = undefined;
    chmodSync(temp, 0o600); renameSync(temp, file); owned = false;
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    if (owned) try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING; }
function validInteger(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
function validDate(value: unknown): value is string { return validString(value) && Number.isFinite(Date.parse(value)); }
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function validPayload(value: unknown): value is CompletionPayload {
  const payload = object(value);
  if (!payload || typeof payload.kind !== "string") return false;
  if (payload.kind === "done") return true;
  if (payload.kind === "ping") return validString(payload.name) && validString(payload.message);
  return payload.kind === "error" && validString(payload.errorMessage) && payload.stopReason === "error";
}
function payloadMatches(reason: CompletionReason, payload: CompletionPayload): boolean {
  return reason === "ping" ? payload.kind === "ping" : reason === "agent-error" ? payload.kind === "error" : payload.kind === "done";
}
function validateFact(value: unknown, runId: string, sourceId: string): value is ChildCompletionFact {
  const fact = object(value);
  if (!fact || typeof fact.kind !== "string" || !FACT_KINDS.has(fact.kind) || fact.runId !== runId || fact.sourceId !== sourceId || !validInteger(fact.sequence, 1) || !validDate(fact.observedAt)) return false;
  if (fact.kind === "completion-requested") return typeof fact.reason === "string" && COMPLETION_REASONS.has(fact.reason as CompletionReason);
  if (fact.kind === "agent-ended") return fact.willRetry === undefined || typeof fact.willRetry === "boolean";
  if (fact.kind === "agent-settled") return true;
  if (fact.kind === "session-shutdown") return validString(fact.reason);
  return typeof fact.estimated === "boolean" && (fact.activity === undefined || validString(fact.activity));
}

/** `completion-requested` records require their matching typed payload. */
export function createChildCompletionRecorder(params: { runId: string; childPid: number; sessionFile: string; snapshotFile: string; now?: () => string }) {
  requireRunId(params.runId);
  if (!validInteger(params.childPid, 1)) throw new Error("childPid must be a positive integer");
  if (!validString(params.sessionFile)) throw new Error("sessionFile is invalid");
  let sequence = 0; let facts: ChildCompletionFact[] = []; let completionPayload: CompletionPayload | undefined;
  const now = params.now ?? (() => new Date().toISOString());
  return {
    record(input: ChildCompletionFactInput, payload?: CompletionPayload): ChildCompletionSnapshot {
      const observedAt = now(); if (!validDate(observedAt)) throw new Error("now returned an invalid timestamp");
      if (input.kind === "completion-requested") {
        if (!validPayload(payload) || !payloadMatches(input.reason, payload)) throw new Error("completion payload does not match reason");
        completionPayload = payload;
      } else if (payload !== undefined) throw new Error("payload is only valid for completion-requested");
      sequence++;
      const sourceId = `pi-child:${params.runId}`;
      const fact = { ...input, runId: params.runId, sourceId, sequence, observedAt } as ChildCompletionFact;
      if (!validateFact(fact, params.runId, sourceId)) throw new Error("invalid completion fact");
      facts = [...facts.filter(previous => previous.kind !== fact.kind), fact].slice(-MAX_FACTS);
      const snapshot: ChildCompletionSnapshot = { version: 1, runId: params.runId, sourceId, sequence, observedAt, childPid: params.childPid, sessionFile: params.sessionFile, ...(completionPayload ? { completionPayload } : {}), latestFacts: facts };
      atomicWrite(params.snapshotFile, snapshot, sequence); return snapshot;
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
export function readChildCompletionSnapshot(file: string, expectedRunId: string, afterSequence = 0): SidecarReadResult<ChildCompletionSnapshot> {
  const read = readJson(file); if (!read.ok) return read;
  const value = object(read.value);
  if (!value || value.version !== 1) return { ok: false, reason: "invalid", error: "unsupported snapshot shape or version" };
  if (value.runId !== expectedRunId || value.sourceId !== `pi-child:${expectedRunId}`) return { ok: false, reason: "wrong-id" };
  if (!validInteger(value.sequence, 1) || !validDate(value.observedAt) || !validInteger(value.childPid, 1) || !validString(value.sessionFile) || !Array.isArray(value.latestFacts) || value.latestFacts.length > MAX_FACTS || (value.completionPayload !== undefined && !validPayload(value.completionPayload))) return { ok: false, reason: "invalid", error: "invalid snapshot fields" };
  if (value.sequence <= afterSequence) return { ok: false, reason: "stale" };
  if (!value.latestFacts.every(f => validateFact(f, expectedRunId, value.sourceId as string))) return { ok: false, reason: "invalid", error: "invalid lifecycle fact" };
  const facts = value.latestFacts as ChildCompletionFact[];
  const sequence = value.sequence;
  const sequences = facts.map(f => f.sequence); const kinds = facts.map(f => f.kind);
  if (new Set(sequences).size !== sequences.length || new Set(kinds).size !== kinds.length || sequences.some((n, i) => i > 0 && n <= sequences[i - 1]!) || sequences.some(n => n > sequence) || sequences.at(-1) !== sequence) return { ok: false, reason: "invalid", error: "facts are duplicate, stale, or inconsistent with snapshot sequence" };
  const request = facts.find(f => f.kind === "completion-requested");
  if ((request === undefined) !== (value.completionPayload === undefined) || (request?.kind === "completion-requested" && !payloadMatches(request.reason, value.completionPayload as CompletionPayload))) return { ok: false, reason: "invalid", error: "completion payload does not match request" };
  return { ok: true, value: value as unknown as ChildCompletionSnapshot };
}
export function readWrapperExitRecord(file: string, expectedRunId: string, afterSequence = 0): SidecarReadResult<WrapperExitRecord> {
  const read = readJson(file); if (!read.ok) return read;
  const value = object(read.value); const exit = object(value?.exit);
  if (!value || value.version !== 1) return { ok: false, reason: "invalid", error: "unsupported wrapper shape or version" };
  if (value.runId !== expectedRunId || value.sourceId !== `wrapper:${expectedRunId}`) return { ok: false, reason: "wrong-id" };
  if (value.sequence !== 1 || !validDate(value.observedAt) || exit?.kind !== "shell" || !validInteger(exit.shellStatus, 0) || (exit.shellStatus as number) > 255) return { ok: false, reason: "invalid", error: "invalid wrapper fields" };
  if (afterSequence >= 1) return { ok: false, reason: "stale" };
  return { ok: true, value: value as unknown as WrapperExitRecord };
}

function shellEscape(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
/** Runs the supplied Pi shell command in the foreground and records only after it returns. */
export function buildVisibleWrapperCommand(params: { piCommand: string; runId: string; wrapperExitFile: string; terminalSentinel?: string }): string {
  requireRunId(params.runId); if (!params.piCommand.trim()) throw new Error("piCommand is required");
  const writer = `const fs=require('node:fs'),path=require('node:path');const file=process.argv[1],runId=process.argv[2],status=Number(process.argv[3]);const record={version:1,runId,sourceId:'wrapper:'+runId,sequence:1,observedAt:new Date().toISOString(),exit:{kind:'shell',shellStatus:status}};fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(record)+'\\n',{mode:384,flag:'wx'});fs.chmodSync(temp,384);fs.renameSync(temp,file);`;
  const sentinel = params.terminalSentinel === undefined ? "" : `\nprintf '%s\\n' ${shellEscape(params.terminalSentinel)}`;
  return `if\n${params.piCommand}\nthen\n  _pi_status=0\nelse\n  _pi_status=$?\nfi\nif node -e ${shellEscape(writer)} ${shellEscape(params.wrapperExitFile)} ${shellEscape(params.runId)} "$_pi_status"; then :; else :; fi${sentinel}\nexit "$_pi_status"`;
}
