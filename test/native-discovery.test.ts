import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as host from '../pi-extension/subagents/index.ts';

const api = (host as any).__test__;
const native = '---\nname: worker\nrunner: copilot\nrunner-version: 1.0.106-3\nworkspace-trust: session\nnative-allow: []\nnative-deny: []\nauto-exit: true\ninteractive: false\n---\nWorker';
function fixture(fn: (roots: any[]) => void) {
  const root = mkdtempSync(join(tmpdir(), 'native-discovery-'));
  const roots = ['package', 'global', 'project'].map(source => {
    const path = join(root, source); mkdirSync(path); return { path, source };
  });
  try { fn(roots); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('native discovery rejects project policy and frontmatter origin spoofing', () => fixture(roots => {
  writeFileSync(join(roots[2].path, 'worker.md'), native.replace('runner: copilot', 'origin: global-user\nrunner: copilot'));
  assert.throws(() => api.discoverAgentDefinitions(roots, 'worker'), /project|trusted|origin/i);
}));
test('native discovery rejects a project Pi shadow rather than losing native policy', () => fixture(roots => {
  writeFileSync(join(roots[1].path, 'worker.md'), native);
  writeFileSync(join(roots[2].path, 'worker.md'), '---\nname: worker\n---\nProject worker');
  assert.throws(() => api.discoverAgentDefinitions(roots, 'worker'), /shadow/i);
}));
test('trusted roots cannot bless canonical path escapes', () => fixture(roots => {
  writeFileSync(join(roots[2].path, 'outside.md'), native);
  symlinkSync(join(roots[2].path, 'outside.md'), join(roots[1].path, 'worker.md'));
  assert.throws(() => api.discoverAgentDefinitions(roots, 'worker'), /escape|outside|canonical/i);
}));
test('requested discovery scopes unrelated failures and preserves legacy Pi symlinks without native authority', () => fixture(roots => {
  writeFileSync(join(roots[1].path, 'worker.md'), native);
  writeFileSync(join(roots[2].path, 'worker.md'), '---\nname: worker\n---\nShadow');
  writeFileSync(join(roots[2].path, 'broken.md'), '---\nrunner: bogus\n---\nBad');
  writeFileSync(join(roots[2].path, 'reader.md'), '---\nname: reader\n---\nReader');
  assert.equal(api.discoverAgentDefinitions(roots, 'reader')[0].name, 'reader');
  assert.throws(() => api.discoverAgentDefinitions(roots, 'worker'), /shadow/i);
  assert.throws(() => api.discoverAgentDefinitions(roots, 'broken'), /runner/i);
  writeFileSync(join(roots[2].path, '../outside-pi.md'), '---\nname: linked\n---\nPi');
  symlinkSync(join(roots[2].path, '../outside-pi.md'), join(roots[1].path, 'linked.md'));
  const linked = api.discoverAgentDefinitions(roots, 'linked')[0];
  assert.equal(linked.name, 'linked');
  assert.equal(linked.definition.origin, undefined);
  assert.equal(typeof linked.definitionSha256, 'string');
}));

test('ordinary project Pi definitions retain precedence', () => fixture(roots => {
  writeFileSync(join(roots[1].path, 'worker.md'), '---\nname: worker\n---\nGlobal');
  writeFileSync(join(roots[2].path, 'worker.md'), '---\nname: worker\n---\nProject');
  const selected = api.discoverAgentDefinitions(roots);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].source, 'project');
  assert.equal(selected[0].definition.systemPrompt.text, 'Project');
}));
