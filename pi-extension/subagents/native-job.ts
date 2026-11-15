import { lstatSync, accessSync, constants, readFileSync, realpathSync, statSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { bindNativeMcp, requireTrustedNativeOrigin, type NormalizedAgentDefinition, type NativeScopeBindings } from 'pi-agent-execution';
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
  skills?: readonly import('pi-agent-execution').NativeSkillSnapshot[];
  bindings?: NativeScopeBindings;
  resume?: boolean;
}

/** Authority and supported modes precede lookup/version probing; no task is launched here. */
export function prepareNativeJob(definition: NormalizedAgentDefinition, params: NativeJobParams, context: NativeHostContext) {
  requireTrustedNativeOrigin(definition.origin);
  if (!['copilot', 'claude'].includes(definition.runner) || !definition.native) throw new Error('A trusted native policy is required');
  const policy = definition.native;
  if (definition.metadata['auto-exit'] !== true || (params.interactive ?? definition.metadata.interactive ?? false) !== false) {
    throw new Error('Native jobs require auto-exit: true and interactive: false');
  }
  if (params.fork || (definition.metadata['session-mode'] !== undefined && definition.metadata['session-mode'] !== 'new')) {
    throw new Error('Native jobs support new sessions only; fork and lineage modes require Pi');
  }
  for (const key of ['tools', 'skills', 'model', 'thinking', 'systemPrompt', 'resumeSessionId'] as const) {
    if (params[key]?.trim()) throw new Error(`Native jobs do not accept ${key} overrides; select a trusted native definition`);
  }
  if (definition.tools !== undefined || definition.metadata['deny-tools'] !== undefined || definition.metadata.spawning !== undefined) {
    throw new Error('Native jobs cannot enforce Pi tools/deny-tools/spawning controls; use native-allow/native-deny');
  }
  if ((definition.skills ?? []).some((name, index) => context.skills?.[index]?.name !== name) || (context.skills?.length ?? 0) !== (definition.skills?.length ?? 0)) throw new Error('Native selected skills require trusted host skill bindings');
  const bindings = context.bindings ?? { parentCwd: context.parentCwd, managedSessionId: context.managedSessionId, todoPathLiteral: context.env.PI_TODO_PATH ?? '' };
  if (bindings.parentCwd !== context.parentCwd || bindings.managedSessionId !== context.managedSessionId) throw new Error('Native MCP binding scope mismatch');
  const home = context.env.HOME || homedir();
  const mcp = bindNativeMcp(policy, { ...bindings, home, node: process.execPath });
  if (policy.allow.some(value => value.startsWith('tasks(') || value.startsWith('mcp__tasks__')) && !mcp.tasks) throw new Error('Required tasks MCP binding is missing');
  if (mcp.tasks) {
    const args = mcp.tasks.args;
    const actions = args[args.indexOf('--actions') + 1]?.split(',') ?? [];
    const supportedActions = ['list', 'list-all', 'get', 'create', 'update', 'append', 'delete', 'claim', 'release'];
    if (args.some(arg => /^--(?:allow-force|force)(?:=|$)/.test(arg)) || !actions.length || actions.some(action => !supportedActions.includes(action))) {
      throw new Error('Tasks MCP requires declared supported actions and no assignment-force flags');
    }
    if (mcp.tasks.command !== process.execPath || mcp.tasks.env?.HOME !== home
      || ['--scope-cwd', '--actor', '--actions'].some(flag => args.filter(arg => arg === flag).length !== 1)
      || args[args.indexOf('--scope-cwd') + 1] !== bindings.parentCwd
      || args.filter(arg => arg.startsWith('--store-override=')).length !== 1
      || !args.includes(`--store-override=${bindings.todoPathLiteral}`)
      || args[args.indexOf('--actor') + 1] !== bindings.managedSessionId
      || !args[args.indexOf('--actions') + 1]?.trim()) throw new Error('Tasks MCP binding requires explicit host node/HOME, captured scope, store override, actor and actions');
  }
  if (definition.runner === 'claude') return prepareClaudeJob(definition, params, context, bindings, home, mcp);
  const mcpConfig = Object.keys(mcp).length ? JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(mcp).map(([name, server]) => [name, { type: 'local', ...server, tools: ['*'] }])) }) : undefined;
  if (definition.systemPrompt?.mode) throw new Error('Copilot cannot materialize Pi system-prompt modes; use the definition body as role instructions');
  if (!definition.model || definition.model.includes('/')) throw new Error('Copilot requires a native model name, not a provider-prefixed Pi model');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(policy.runnerVersion)) throw new Error('Copilot requires an explicit cached runner-version');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(context.nativeName)) throw new Error('Invalid host-owned native session name');
  const prompt = [definition.systemPrompt?.text,
    mcp.tasks ? 'Binding hint: todo(...) examples refer to MCP server tasks, tool todo. Use only its declared actions.' : undefined,
    ...(context.skills ?? []).map(skill => `Skill: ${skill.name}\nBase directory: ${skill.baseDir}\n${skill.body}`),
    params.task].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(prompt) > 60 * 1024 || prompt.includes('\0')) throw new Error('Copilot prompt exceeds 60 KiB or contains NUL; instructions were not truncated');
  const cwd = resolve(context.parentCwd, params.cwd?.trim() || definition.cwd || '.');
  if (!statSync(cwd).isDirectory()) throw new Error('Copilot cwd must be an existing directory');
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
    ...(mcpConfig ? ['--additional-mcp-config', mcpConfig] : []),
    context.resume ? '--resume' : '--name', context.nativeName, ...(!context.resume && policy.workspaceTrust === 'session' ? ['--trust-folder'] : []), '--prompt', prompt];
  return {
    argv, cwd,
    nativeReference: { runner: 'copilot' as const, selector: { kind: 'name' as const, value: context.nativeName }, managedSessionId: context.managedSessionId, cwd },
    context: { parentCwd: bindings.parentCwd, managedSessionId: bindings.managedSessionId, env: { PI_TODO_PATH: bindings.todoPathLiteral } },
    skills: context.skills ?? [],
  };
}

/** Deliberately narrower than Claude's general ancestor trust: only a verified Git root. */
function hasExistingClaudeTrust(home: string, cwd: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const projects = config?.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return false;
    const accepted = (path: string) => Object.hasOwn(projects, path)
      && projects[path]?.hasTrustDialogAccepted === true;
    if (accepted(cwd)) return true;
    for (let candidate = cwd; ; candidate = dirname(candidate)) {
      let marker;
      try { marker = lstatSync(join(candidate, '.git')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
      if (marker) {
        // The nearest marker is a boundary even when malformed or unsupported.
        if ((!marker.isDirectory() && !marker.isFile()) || !accepted(candidate)) return false;
        const top = execFileSync('/usr/bin/git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
          env: { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
          encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        return realpathSync(top) === candidate;
      }
      if (dirname(candidate) === candidate) return false;
    }
  } catch { return false; }
}

function prepareClaudeJob(definition: NormalizedAgentDefinition, params: NativeJobParams, context: NativeHostContext,
  bindings: NativeScopeBindings, home: string, mcp: ReturnType<typeof bindNativeMcp>) {
  const policy = definition.native!;
  if (context.env.CLAUDE_CONFIG_DIR || context.env.CLAUDE_CODE_IGNORE_PERSISTED_TRUST) throw new Error('Unsupported Claude trust-store or persisted-trust override');
  if (policy.workspaceTrust !== 'existing') throw new Error('Claude requires verified existing workspace trust');
  if (definition.systemPrompt?.mode) throw new Error('Claude native jobs do not accept Pi system-prompt modes');
  if (!definition.model || definition.model.includes('/')) throw new Error('Claude requires a native model name');
  if (definition.thinking && !['low', 'medium', 'high', 'xhigh', 'max'].includes(definition.thinking)) throw new Error('Unsupported Claude effort');
  if (!/^\d+\.\d+\.\d+$/.test(policy.runnerVersion)) throw new Error('Claude requires an explicit runner-version');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.nativeName)) throw new Error('Claude requires a host-owned UUID');
  if (!Array.isArray(policy.nativeTools) || !['manual', 'dontAsk', 'plan'].includes(policy.permissionMode ?? '')) throw new Error('Claude requires native-tools and permission-mode');
  const supportedTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
  if (policy.nativeTools.some(tool => !supportedTools.includes(tool))) throw new Error('Unsupported Claude native-tools; this slice supports Read, Glob, Grep, Edit, Write and Bash only');
  for (const rule of [...policy.allow, ...policy.deny]) {
    const builtin = [...supportedTools, 'Agent'].some(tool => rule === tool || (rule.startsWith(`${tool}(`) && rule.endsWith(')')));
    const explicitMcp = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(rule) && Object.keys(mcp).some(name => rule.startsWith(`mcp__${name}__`));
    if (!builtin && !explicitMcp) throw new Error(`Unsupported Claude native permission rule: ${rule}`);
  }
  const cwd = realpathSync(resolve(context.parentCwd, params.cwd?.trim() || definition.cwd || '.'));
  if (!statSync(cwd).isDirectory()) throw new Error('Claude cwd must be an existing directory');
  if (!hasExistingClaudeTrust(home, cwd)) throw new Error('Claude print mode requires an existing trusted workspace (canonical cwd or verified repository root); trust was not changed');
  const instructions = [definition.systemPrompt?.text,
    mcp.tasks ? 'Binding hint: todo(...) examples refer to MCP server tasks, tool todo. Use only its declared actions.' : undefined,
    ...(context.skills ?? []).map(skill => `Skill: ${skill.name}\nBase directory: ${skill.baseDir}\n${skill.body}`)].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(instructions + params.task) > 60 * 1024 || (instructions + params.task).includes('\0')) throw new Error('Claude prompt exceeds 60 KiB or contains NUL; instructions were not truncated');
  const executable = (context.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, 'claude')).find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error('Claude executable is not installed on the host PATH; no installation was attempted');
  realpathSync(executable);
  const env = { ...context.env, HOME: home, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const version = execFileSync(executable, ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
  if (version !== `${policy.runnerVersion} (Claude Code)`) throw new Error('Installed Claude does not match runner-version');
  const runtimeGuard = 'if [[ -n "${CLAUDE_CONFIG_DIR:-}" || -n "${CLAUDE_CODE_IGNORE_PERSISTED_TRUST:-}" ]]; then printf "%s\\n" "Unsupported Claude runtime trust override" >&2; exit 78; fi\nexec "$@"';
  const argv = ['/bin/bash', '--noprofile', '--norc', '-c', runtimeGuard, 'native-claude',
    '/usr/bin/env', `HOME=${home}`, 'DISABLE_AUTOUPDATER=1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS=1', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', 'ENABLE_CLAUDEAI_MCP_SERVERS=false', executable,
    '--print', '--output-format', 'text', '--disable-slash-commands', '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true }),
    '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(mcp).map(([name, server]) => [name, { type: 'stdio', ...server }])) }),
    '--model', definition.model, ...(definition.thinking ? ['--effort', definition.thinking] : []),
    '--tools', policy.nativeTools.join(','), '--permission-mode', policy.permissionMode!, '--permission-prompts', 'none',
    ...policy.allow.flatMap(value => ['--allowedTools', value]), ...policy.deny.flatMap(value => ['--disallowedTools', value]),
    '--system-prompt-snapshot', 'off', ...(instructions ? ['--append-system-prompt', instructions] : []),
    context.resume ? '--resume' : '--session-id', context.nativeName, '--', params.task];
  return { argv, cwd,
    nativeReference: { runner: 'claude' as const, selector: { kind: 'uuid' as const, value: context.nativeName }, managedSessionId: context.managedSessionId, cwd },
    context: { parentCwd: bindings.parentCwd, managedSessionId: bindings.managedSessionId, env: { PI_TODO_PATH: bindings.todoPathLiteral } },
    skills: context.skills ?? [] };
}
