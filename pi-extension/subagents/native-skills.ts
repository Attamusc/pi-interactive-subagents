import { DefaultPackageManager, SettingsManager, loadSkills, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { NativeSkillSnapshot } from 'pi-agent-execution';

/** Rejection inventory only: never a source of native prompt bodies. */
async function projectSkillNames(cwd: string, agentDir: string): Promise<Set<string>> {
  let raw: string | undefined;
  try { raw = readFileSync(join(cwd, '.pi', 'settings.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const settingsManager = SettingsManager.fromStorage({ withLock(scope, fn) {
    const current = scope === 'global' ? '{}' : raw;
    const result = fn(current);
    if (result !== undefined && result !== current) throw new Error('Native skill inventory forbids settings writes');
  } }, { projectTrusted: true });
  if (settingsManager.drainErrors().length) throw new Error('Cannot verify native skill shadows: malformed project settings');
  if (process.env.PI_OFFLINE && settingsManager.getProjectSettings().packages?.length) {
    throw new Error('Cannot verify project package skill shadows while PI_OFFLINE is set');
  }
  const resources = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(async () => 'error');
  if (settingsManager.drainErrors().length) throw new Error('Cannot verify native skill shadows: settings error');
  const names = new Set<string>();
  for (const resource of [...resources.extensions, ...resources.skills]) {
    const metadata = resource.metadata;
    if (!metadata || !['user', 'project', 'temporary'].includes(metadata.scope) || !['top-level', 'package'].includes(metadata.origin)) {
      throw new Error('Cannot verify native skill shadow provenance');
    }
  }
  if (resources.extensions.some(resource => resource.metadata.scope === 'project' && resource.metadata.source !== 'builtin')) {
    throw new Error('Native selected skills cannot verify dynamic project extension resources (including disabled extensions)');
  }
  for (const resource of resources.skills) {
    if (resource.metadata.scope !== 'project') continue;
    // Disabled resources still count. Metadata scope survives canonical symlinks.
    const result = loadSkills({ cwd, agentDir, skillPaths: [resource.path], includeDefaults: false });
    for (const skill of result.skills) names.add(skill.name);
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.type === 'collision' && diagnostic.collision?.resourceType === 'skill') names.add(diagnostic.collision.name);
      else throw new Error('Cannot materialize project skill shadow inventory');
    }
  }
  return names;
}

export async function assertNoNativeSkillShadows(names: readonly string[], cwd: string, agentDir: string): Promise<void> {
  if (!names.length) return;
  const shadows = await projectSkillNames(cwd, agentDir);
  for (const name of names) if (shadows.has(name)) throw new Error(`Project skill shadow forbids native skill '${name}'`);
}

export async function resolveNativeSkills(names: readonly string[], commands: ReturnType<ExtensionAPI['getCommands']>, cwd: string, agentDir: string): Promise<readonly NativeSkillSnapshot[]> {
  await assertNoNativeSkillShadows(names, cwd, agentDir);
  return names.map(name => {
    const matches = commands.filter(command => command.source === 'skill' && command.name === `skill:${name}`);
    if (matches.length !== 1) throw new Error(`Missing or ambiguous parent skill '${name}'`);
    const info = matches[0].sourceInfo;
    if (!info || info.scope !== 'user' || !['top-level', 'package'].includes(info.origin)) {
      throw new Error(`Native skill '${name}' requires verified parent user/package provenance`);
    }
    if (!isAbsolute(info.path)) throw new Error(`Native skill '${name}' lacks a canonical body path`);
    const file = realpathSync(info.path);
    // SourceInfo.baseDir may be a package root, not Skill.baseDir. Preserve
    // its containment constraint, but resolve skill-relative resources at the
    // canonical SKILL.md directory, exactly as the parent skill loader does.
    if (info.baseDir) {
      if (!isAbsolute(info.baseDir)) throw new Error('Invalid parent skill source base directory');
      const rel = relative(realpathSync(info.baseDir), file);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Native skill body escapes its source base directory');
    }
    return { name, baseDir: dirname(file), body: readFileSync(file, 'utf8') };
  });
}
