import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, lstatSync, readlinkSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { resolveNativeSkills } from '../pi-extension/subagents/native-skills.ts';
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

function put(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function skill(path: string, body = 'WINNING BYTES\n') { put(path, `---\nname: selected\ndescription: Synthetic skill\n---\n${body}`); }
function tree(path: string): unknown {
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) return { link: readlinkSync(path) };
  if (lstatSync(path).isDirectory()) return Object.fromEntries(readdirSync(path).sort().map(name => [name, tree(join(path, name))]));
  return readFileSync(path, 'hex');
}
async function fixture(fn: (f: any) => Promise<void>) {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'native-skills-'));
  const home = join(root, 'home'), cwd = join(home, 'projects/repo'), agentDir = join(home, 'agent');
  mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir);
  process.env.HOME = home; delete process.env.PI_OFFLINE;
  const file = join(agentDir, 'skills/selected/SKILL.md'); skill(file);
  const commands = [{ name: 'skill:selected', source: 'skill', sourceInfo: { path: file, baseDir: dirname(file), scope: 'user', origin: 'top-level', source: 'auto' } }];
  const settings = (data: unknown) => put(join(cwd, '.pi/settings.json'), JSON.stringify(data));
  const resolve = () => resolveNativeSkills(['selected'], commands as any, cwd, agentDir);
  try { await fn({ root, home, cwd, agentDir, file, commands, settings, resolve }); }
  finally { process.env = saved; rmSync(root, { recursive: true, force: true }); }
}

for (const scenario of ['project-root', 'ancestor-agents', 'configured-external', 'disabled-skill', 'project-symlink', 'hidden-package', 'untrusted-parent-shadow']) {
  test(`native snapshot rejects SDK-resolved ${scenario} without writes`, () => fixture(async f => {
    let target = join(f.cwd, '.pi/skills/selected/SKILL.md');
    if (scenario === 'ancestor-agents') target = join(f.home, 'projects/.agents/skills/selected/SKILL.md');
    if (scenario === 'configured-external') { target = join(f.root, 'outside/SKILL.md'); f.settings({ skills: [target] }); }
    if (scenario === 'disabled-skill') f.settings({ skills: ['-.pi/skills/selected/SKILL.md', '-skills/selected/SKILL.md'] });
    if (scenario === 'hidden-package') {
      const pkg = join(f.cwd, '.pi/npm/node_modules/project-skill');
      target = join(pkg, 'skills/selected/SKILL.md');
      put(join(pkg, 'package.json'), JSON.stringify({ name: 'project-skill', version: '1.0.0', pi: { skills: ['skills'] } }));
      f.settings({ packages: ['npm:project-skill'] });
    }
    if (scenario === 'project-symlink') { mkdirSync(dirname(target), { recursive: true }); symlinkSync(f.file, target); }
    else skill(target, 'SHADOW MUST NEVER BE DELIVERED');
    if (scenario === 'disabled-skill') {
      const settingsManager = SettingsManager.fromStorage({ withLock(scope, fn) { fn(scope === 'global' ? '{}' : readFileSync(join(f.cwd, '.pi/settings.json'), 'utf8')); } });
      const resources = await new DefaultPackageManager({ cwd: f.cwd, agentDir: f.agentDir, settingsManager }).resolve(async () => 'error');
      assert.equal(resources.skills.find(resource => resource.path === target)?.enabled, false, 'fixture is actually disabled by SDK filtering');
    }
    const before = tree(f.root);
    await assert.rejects(f.resolve, /project skill shadow/i);
    assert.deepEqual(tree(f.root), before);
  }));
}
for (const disabled of [false, true]) test(`native snapshot refuses ${disabled ? 'disabled' : 'enabled'} project extension without executing it`, () => fixture(async f => {
  const sentinel = join(f.root, 'executed');
  const extension = join(f.cwd, '.pi/extensions/sentinel.ts');
  put(extension, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'BAD');`);
  if (disabled) {
    f.settings({ extensions: ['-extensions/sentinel.ts'] });
    const settingsManager = SettingsManager.fromStorage({ withLock(scope, fn) { fn(scope === 'global' ? '{}' : readFileSync(join(f.cwd, '.pi/settings.json'), 'utf8')); } });
    const resources = await new DefaultPackageManager({ cwd: f.cwd, agentDir: f.agentDir, settingsManager }).resolve(async () => 'error');
    assert.equal(resources.extensions.find(resource => resource.path === extension)?.enabled, false, 'fixture extension is actually disabled');
  }
  const before = tree(f.root);
  await assert.rejects(f.resolve, /project extension/i);
  assert.deepEqual(tree(f.root), before);
  assert.equal(existsSync(sentinel), false);
}));
for (const offline of [false, true]) test(`missing project package fails without spawn or mutation (offline=${offline})`, () => fixture(async f => {
  const sentinel = join(f.root, 'spawned');
  const executable = join(f.root, 'bin/npm');
  put(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)},'BAD');`);
  const { chmodSync } = await import('node:fs'); chmodSync(executable, 0o700);
  for (const name of ['git', 'pnpm', 'bun']) symlinkSync(executable, join(f.root, 'bin', name));
  process.env.PATH = join(f.root, 'bin');
  if (offline) process.env.PI_OFFLINE = '1';
  f.settings({ packages: ['npm:missing-native-skill-package'], npmCommand: executable });
  const before = tree(f.root);
  await assert.rejects(f.resolve, offline ? /PI_OFFLINE/ : /missing source/i);
  assert.equal(existsSync(sentinel), false);
  assert.deepEqual(tree(f.root), before, 'no locks, install roots, gitignore or other writes');
}));
test('malformed project settings cannot silently omit shadows', () => fixture(async f => {
  put(join(f.cwd, '.pi/settings.json'), '{broken');
  const before = tree(f.root); await assert.rejects(f.resolve, /malformed/i); assert.deepEqual(tree(f.root), before);
}));
test('parent user top-level/package winners supply exact bytes; native HOME .agents is not a project shadow', () => fixture(async f => {
  skill(join(f.home, '.agents/skills/selected/SKILL.md'), 'OTHER GLOBAL BYTES');
  const before = tree(f.root);
  for (const origin of ['top-level', 'package']) {
    f.commands[0].sourceInfo.origin = origin;
    assert.deepEqual(await f.resolve(), [{ name: 'selected', baseDir: dirname(f.file), body: readFileSync(f.file, 'utf8') }]);
  }
  assert.deepEqual(tree(f.root), before);
}));
test('real parent package metadata does not replace the canonical skill base directory', () => fixture(async f => {
  const pkg = join(f.root, 'trusted-package');
  const file = join(pkg, 'skills/packaged/SKILL.md'); put(file, '---\nname: packaged\ndescription: Packaged fixture\n---\nPARENT PACKAGE BYTES');
  put(join(pkg, 'package.json'), JSON.stringify({ name: 'trusted-package', version: '1.0.0', pi: { skills: ['skills'] } }));
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir, settingsManager: SettingsManager.inMemory({ packages: [pkg] }), noExtensions: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  // The actual parent loader catalog is authoritative.
  const selected = loader.getSkills().skills.find(skill => skill.filePath === file);
  assert.ok(selected, 'package skill is materialized by the parent loader');
  const commands = [{ name: `skill:${selected.name}`, source: 'skill' as const, sourceInfo: selected.sourceInfo }];
  assert.equal(selected.sourceInfo.scope, 'user'); assert.equal(selected.sourceInfo.origin, 'package');
  assert.deepEqual(await resolveNativeSkills([selected.name], commands, f.cwd, f.agentDir), [{ name: selected.name, body: readFileSync(file, 'utf8'), baseDir: dirname(file) }]);
}));

for (const provenance of [undefined, { scope: 'project', origin: 'package' }, { scope: 'temporary', origin: 'top-level' }]) {
  test(`unprovenanced/project-package/temporary parent skill winner is rejected: ${JSON.stringify(provenance)}`, () => fixture(async f => {
    f.commands[0].sourceInfo = provenance && { ...f.commands[0].sourceInfo, ...provenance };
    await assert.rejects(f.resolve, /provenance/i);
  }));
}
