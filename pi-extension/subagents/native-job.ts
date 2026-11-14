import { accessSync, constants, readFileSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { requireTrustedNativeOrigin, type NormalizedAgentDefinition } from 'pi-agent-execution';
import { shellEscape } from './cmux.ts';

export interface NativeCapturePaths { stdout: string; stderr: string; status: string }

export function buildNativeCaptureCommand(argv: readonly string[], paths: NativeCapturePaths, runId: string): string {
  const format = JSON.stringify({ runId, nativeExit: '%NATIVE%', captureExit: '%CAPTURE%' })
    .replace('"%NATIVE%"', '%d').replace('"%CAPTURE%"', '%d') + '\\n';
  const entryFormat = JSON.stringify({ runId, pid: '%PID%' }).replace('"%PID%"', '%d') + '\\n';
  const entryScript = `printf ${shellEscape(entryFormat)} "$$" > ${shellEscape(paths.status + '.entry.json')} || exit 66; exec "$@"`;
  return [
    'umask 077', 'set -o pipefail', 'set -o noclobber',
    `: > ${shellEscape(paths.stdout)} || exit 64`,
    `: > ${shellEscape(paths.stderr)} || exit 64`,
    `/bin/bash -c ${shellEscape(entryScript)} native-entry ${argv.map(shellEscape).join(' ')} 2>> ${shellEscape(paths.stderr)} | /usr/bin/tee -a ${shellEscape(paths.stdout)}`,
    'statuses=("${PIPESTATUS[@]}")',
    `printf ${shellEscape(format)} "${'${statuses[0]}'}" "${'${statuses[1]}'}" > ${shellEscape(paths.status)} || exit 65`,
    'if [ "${statuses[0]}" -ne 0 ]; then exit "${statuses[0]}"; fi',
    'exit "${statuses[1]}"',
  ].join('\n');
}

function readPrivateTail(path: string, limit: number) {
  const fd = openSync(path, 'r');
  try {
    const bytes = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(bytes, limit));
    const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, bytes - limit));
    let offset = 0;
    while (offset < count && (buffer[offset] & 0xc0) === 0x80) offset++;
    return { text: buffer.subarray(offset, count).toString('utf8'), bytes, truncated: bytes > limit };
  } finally { closeSync(fd); }
}

export function readNativeCapture(paths: NativeCapturePaths, runId: string) {
  const status = JSON.parse(readFileSync(paths.status, 'utf8'));
  if (status.runId !== runId || ![status.nativeExit, status.captureExit].every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    throw new Error('Uncorrelated or invalid native capture status');
  }
  if (status.captureExit !== 0) throw new Error(`Native stdout capture failed with status ${status.captureExit}`);
  return readCapturedOutput(paths, true, status.nativeExit);
}

export function readNativePartialCapture(paths: NativeCapturePaths) {
  return readCapturedOutput(paths, false, null);
}

function readCapturedOutput(paths: NativeCapturePaths, complete: boolean, nativeExit: number | null) {
  const stdout = readPrivateTail(paths.stdout, 64 * 1024);
  const stderr = readPrivateTail(paths.stderr, 8 * 1024);
  return {
    output: stdout.text, diagnostic: stderr.text, nativeExit,
    capture: { source: 'current-job-stdout' as const, path: paths.stdout, diagnosticPath: paths.stderr,
      complete, bytes: stdout.bytes, limitBytes: 64 * 1024, truncated: stdout.truncated,
      diagnosticBytes: stderr.bytes, diagnosticLimitBytes: 8 * 1024, diagnosticTruncated: stderr.truncated },
  };
}

export interface NativeEntryProof { state: 'alive' | 'absent' | 'unconfirmed'; pid?: number; reason?: string }

export function probeNativeEntry(paths: NativeCapturePaths, runId: string, probe: (pid: number, signal: 0) => void = process.kill): NativeEntryProof {
  let pid: number;
  try {
    const record = JSON.parse(readFileSync(paths.status + '.entry.json', 'utf8'));
    if (record.runId !== runId || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('Uncorrelated native entry PID');
    pid = record.pid;
  } catch (error) { return { state: 'unconfirmed', reason: error instanceof Error ? error.message : String(error) }; }
  try { probe(pid, 0); return { state: 'alive', pid }; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? { state: 'absent', pid }
      : { state: 'unconfirmed', pid, reason: error instanceof Error ? error.message : String(error) };
  }
}

export interface NativeJobParams {
  name: string; task: string; interactive?: boolean; fork?: boolean;
  model?: string; thinking?: string; tools?: string;
  skills?: string; systemPrompt?: string; cwd?: string; resumeSessionId?: string;
}
export interface NativeHostContext {
  parentCwd: string; managedSessionId: string; nativeName: string;
  env: NodeJS.ProcessEnv;
}

/** No native command is executed here. Authority and supported modes precede even lookup. */
export function prepareNativeJob(definition: NormalizedAgentDefinition, params: NativeJobParams, context: NativeHostContext) {
  requireTrustedNativeOrigin(definition.origin);
  if (definition.runner !== 'copilot' || !definition.native) throw new Error('A trusted Copilot native policy is required');
  const policy = definition.native;
  if (definition.metadata['auto-exit'] !== true || (params.interactive ?? definition.metadata.interactive ?? false) !== false) {
    throw new Error('Copilot jobs require auto-exit: true and interactive: false');
  }
  if (params.fork || (definition.metadata['session-mode'] !== undefined && definition.metadata['session-mode'] !== 'new')) {
    throw new Error('Copilot jobs support new sessions only; fork and lineage modes require Pi');
  }
  for (const key of ['tools', 'skills', 'model', 'thinking', 'systemPrompt', 'resumeSessionId'] as const) {
    if (params[key]?.trim()) throw new Error(`Copilot jobs do not accept ${key} overrides; select a trusted native definition`);
  }
  if (definition.tools !== undefined || definition.metadata['deny-tools'] !== undefined || definition.metadata.spawning !== undefined) {
    throw new Error('Copilot jobs cannot enforce Pi tools/deny-tools/spawning controls; use native-allow/native-deny');
  }
  if (definition.skills?.length) throw new Error('Copilot selected skills require trusted host skill bindings (not yet bound)');
  if (Object.keys(policy.mcp).length) throw new Error('Copilot MCP declarations require host bindings before launch; unbound MCP policy is not executable');
  if (definition.systemPrompt?.mode) throw new Error('Copilot cannot materialize Pi system-prompt modes; use the definition body as role instructions');
  if (!definition.model || definition.model.includes('/')) throw new Error('Copilot requires a native model name, not a provider-prefixed Pi model');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(policy.runnerVersion)) throw new Error('Copilot requires an explicit cached runner-version');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(context.nativeName)) throw new Error('Invalid host-owned native session name');
  const prompt = [definition.systemPrompt?.text, params.task].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(prompt) > 60 * 1024 || prompt.includes('\0')) throw new Error('Copilot prompt exceeds 60 KiB or contains NUL; instructions were not truncated');
  const cwd = resolve(context.parentCwd, params.cwd?.trim() || definition.cwd || '.');
  if (!statSync(cwd).isDirectory()) throw new Error('Copilot cwd must be an existing directory');
  const home = context.env.HOME || homedir();
  const cached = join(home, '.copilot', 'pkg', `${process.platform}-${process.arch}`, policy.runnerVersion);
  let manifest: any;
  try { manifest = JSON.parse(readFileSync(join(cached, 'package.json'), 'utf8')); accessSync(join(cached, 'app.js'), constants.R_OK); }
  catch { throw new Error(`Copilot ${policy.runnerVersion} is not cached in the installed toolchain; install it explicitly outside this job`); }
  if (manifest.version !== policy.runnerVersion) throw new Error('Cached Copilot manifest does not match runner-version');
  const executable = (context.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, 'copilot')).find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error('Copilot executable is not installed on the host PATH; no installation was attempted');
  realpathSync(executable); // Validate the target, but preserve shim argv[0] dispatch.
  const argv = ['/usr/bin/env', 'COPILOT_AUTO_UPDATE=false', executable, '--prefer-version', policy.runnerVersion,
    '--model', definition.model, ...(definition.thinking ? ['--reasoning-effort', definition.thinking === 'off' ? 'none' : definition.thinking] : []),
    '--silent', '--stream', 'off', '--no-color', '--output-format', 'text',
    ...policy.allow.map(value => `--allow-tool=${value}`), ...policy.deny.map(value => `--deny-tool=${value}`),
    '--name', context.nativeName, ...(policy.workspaceTrust === 'session' ? ['--trust-folder'] : []), '--prompt', prompt];
  return {
    argv, cwd,
    nativeReference: { runner: 'copilot' as const, selector: { kind: 'name' as const, value: context.nativeName }, managedSessionId: context.managedSessionId, cwd },
    context: { parentCwd: context.parentCwd, managedSessionId: context.managedSessionId, env: { PI_TODO_PATH: context.env.PI_TODO_PATH ?? '' } },
  };
}
