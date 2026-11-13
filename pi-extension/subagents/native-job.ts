import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { requireTrustedNativeOrigin, type NormalizedAgentDefinition } from 'pi-agent-execution';

export interface NativeJobParams {
  name: string; task: string; interactive?: boolean; fork?: boolean;
  sessionMode?: string; model?: string; thinking?: string; tools?: string;
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
  if (params.fork || (params.sessionMode ?? definition.metadata['session-mode'] ?? 'standalone') !== 'standalone') {
    throw new Error('Copilot jobs support standalone sessions only; fork and lineage modes require Pi');
  }
  for (const key of ['tools', 'skills', 'model', 'thinking', 'systemPrompt', 'resumeSessionId'] as const) {
    if (params[key] != null) throw new Error(`Copilot jobs do not accept ${key} overrides; select a trusted native definition`);
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
  const argv = ['/usr/bin/env', 'COPILOT_AUTO_UPDATE=false', realpathSync(executable), '--prefer-version', policy.runnerVersion,
    '--model', definition.model, ...(definition.thinking ? ['--reasoning-effort', definition.thinking] : []),
    '--silent', '--stream', 'off', '--no-color', '--output-format', 'text',
    ...policy.allow.map(value => `--allow-tool=${value}`), ...policy.deny.map(value => `--deny-tool=${value}`),
    '--name', context.nativeName, ...(policy.workspaceTrust === 'session' ? ['--trust-folder'] : []), '--prompt', prompt];
  return {
    argv, cwd,
    nativeReference: { runner: 'copilot' as const, selector: { kind: 'name' as const, value: context.nativeName }, managedSessionId: context.managedSessionId, cwd },
    context: { parentCwd: context.parentCwd, managedSessionId: context.managedSessionId, env: { PI_TODO_PATH: context.env.PI_TODO_PATH ?? '' } },
  };
}
