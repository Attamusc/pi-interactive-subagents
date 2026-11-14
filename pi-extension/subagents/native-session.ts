import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ManagedNativeSessionRecord } from 'pi-agent-execution';

export const NATIVE_SESSION_ENTRY = 'pi-interactive-subagents.native-session';
export interface NativeSessionEntry {
  version: 1;
  agent: string;
  runId: string;
  state: 'open' | 'closed';
  record: ManagedNativeSessionRecord;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function literal(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && !value.includes('\0'); }
function validEntry(value: unknown): value is NativeSessionEntry {
  if (!object(value) || value.version !== 1 || !literal(value.agent) || !literal(value.runId) || !['open', 'closed'].includes(String(value.state))) return false;
  if (Object.keys(value).some(key => !['version', 'agent', 'runId', 'state', 'record'].includes(key))) return false;
  const r = value.record;
  if (!object(r) || !literal(r.callerSessionId) || !literal(r.definitionSha256) || !object(r.reference) || !object(r.bindings) || !object(r.definitionOrigin) || !Array.isArray(r.skills)) return false;
  if (Object.keys(r).some(key => !['callerSessionId', 'definitionSha256', 'reference', 'bindings', 'definitionOrigin', 'skills'].includes(key))) return false;
  return r.reference.runner === 'copilot' && literal(r.reference.managedSessionId) && literal(r.reference.cwd)
    && object(r.reference.selector) && r.reference.selector.kind === 'name' && literal(r.reference.selector.value)
    && literal(r.bindings.parentCwd) && r.bindings.managedSessionId === r.reference.managedSessionId && typeof r.bindings.todoPathLiteral === 'string'
    && ['global-user', 'installed-package'].includes(String(r.definitionOrigin.kind))
    && literal(r.definitionOrigin.canonicalPath) && literal(r.definitionOrigin.canonicalRoot)
    && r.skills.every(skill => object(skill) && literal(skill.name) && literal(skill.baseDir) && typeof skill.body === 'string');
}

/** Only entries on the actual caller branch convey resume authority. */
export function nativeSessionRecords(ctx: Pick<ExtensionContext, 'sessionManager'>): Map<string, NativeSessionEntry> {
  const records = new Map<string, NativeSessionEntry>();
  const callerId = ctx.sessionManager.getSessionId();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'custom' || entry.customType !== NATIVE_SESSION_ENTRY) continue;
    if (!validEntry(entry.data)) throw new Error('Invalid caller native session record');
    if (entry.data.record.callerSessionId !== callerId) continue;
    records.set(entry.data.record.reference.managedSessionId, entry.data);
  }
  return records;
}
