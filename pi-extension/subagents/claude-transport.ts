import { existsSync, readFileSync, statSync } from "node:fs";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateClaudeReviewLaunch(
  params: { tools?: string; skills?: string; thinking?: string; fork?: boolean; interactive?: boolean; resumeSessionId?: string; task?: string; systemPrompt?: string },
  agent: { tools?: string; skills?: string; thinking?: string; autoExit?: boolean; sessionMode?: string },
): void {
  if (params.tools?.trim() || agent.tools?.trim()) throw new Error("Claude review does not accept tools overrides");
  if (params.skills?.trim() || agent.skills?.trim()) throw new Error("Claude review does not accept skills");
  if (params.fork || agent.sessionMode === "fork") throw new Error("Claude review does not support fork mode");
  if (params.interactive || agent.autoExit !== true) throw new Error("Claude review does not support interactive mode");
  if (params.thinking?.trim() || agent.thinking) throw new Error("Claude review does not accept thinking overrides");
  if (params.resumeSessionId && !SESSION_ID.test(params.resumeSessionId)) throw new Error("invalid Claude session ID");
  if (params.task && Buffer.byteLength(params.task, "utf8") > 60 * 1024) {
    throw new Error("Claude review task exceeds 60 KiB; provide a bounded evidence file path inside cwd");
  }
  if (params.systemPrompt && Buffer.byteLength(params.systemPrompt, "utf8") > 60 * 1024) {
    throw new Error("Claude review system prompt exceeds 60 KiB");
  }
}

export function readClaudeProcessId(file: string, runId: string): number | null {
  if (!existsSync(file)) return null;
  if (statSync(file).size > 128) throw new Error("invalid Claude process ID record");
  const match = readFileSync(file, "utf8").match(/^([a-zA-Z0-9._-]+) ([0-9]+)\n$/);
  if (!match) throw new Error("invalid Claude process ID record");
  if (match[1] !== runId) return null;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid Claude process ID record");
  return pid;
}

export function confirmClaudeProcessGone(
  processIdFile: string, runId: string,
  probe: (pid: number, signal: 0) => void = process.kill,
): boolean {
  const pid = readClaudeProcessId(processIdFile, runId);
  if (pid === null) return false;
  try { probe(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function readClaudeFailureResult(file: string): string | undefined {
  try {
    if (statSync(file).size > 1024 * 1024) return undefined;
    const result: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
    const value = result as Record<string, unknown>;
    return value.type === "result" && typeof value.result === "string" && value.result.trim()
      ? value.result.slice(0, 4_000) : undefined;
  } catch { return undefined; }
}

export function readClaudePrintResult(file: string): { summary: string; sessionId: string } {
  if (statSync(file).size > 1024 * 1024) throw new Error("Claude result exceeds 1 MiB");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude result is not an object");
  const result = value as Record<string, unknown>;
  if (result.type !== "result" || result.subtype !== "success" || result.is_error !== false ||
      typeof result.result !== "string" || !result.result.trim() ||
      typeof result.session_id !== "string" || !SESSION_ID.test(result.session_id)) {
    throw new Error("Claude result is not a successful resumable response");
  }
  return { summary: result.result.slice(0, 20_000), sessionId: result.session_id };
}
