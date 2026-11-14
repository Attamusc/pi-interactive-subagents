import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as host from '../pi-extension/subagents/index.ts';
const api = (host as any).__test__;
const definition = { name: 'worker', runner: 'copilot', native: { runnerVersion: '1.0.106-3', workspaceTrust: 'session', allow: ['write'], deny: ['shell'], mcp: {} }, model: 'gpt-6.1-sol', thinking: 'low', metadata: { 'auto-exit': true, interactive: false } };

test('native launch validates policy before executable lookup and freezes the actual child prefix', () => {
  assert.equal(typeof api.prepareNativeJob, 'function', 'host exposes the native launch seam');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copilot-fixture-')));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const executable = join(bin, 'copilot'); writeFileSync(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const cache = join(root, '.copilot/pkg', `${process.platform}-${process.arch}`, '1.0.106-3'); mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'package.json'), JSON.stringify({ version: '1.0.106-3' }));
    writeFileSync(join(cache, 'app.js'), '');
    const origin = { kind: 'global-user', canonicalPath: join(root, 'worker.md'), canonicalRoot: root };
    const trusted = { ...definition, origin };
    const params = { name: 'job', task: "hello ' $(touch /not-run)", interactive: false };
    const context = { parentCwd: root, managedSessionId: 'managed-1', nativeName: 'unique-name', env: { PATH: bin, HOME: root, PI_TODO_PATH: '../tasks' } };
    assert.throws(() => api.prepareNativeJob(definition, params, context), /origin|trusted/i);
    assert.throws(() => api.prepareNativeJob(trusted, { ...params, fork: true }, context), /fork|standalone/i);
    assert.throws(() => api.prepareNativeJob(trusted, { ...params, tools: 'read' }, context), /tools/i);
    assert.throws(() => api.prepareNativeJob(trusted, { ...params, interactive: true }, context), /interactive/i);
    assert.throws(() => api.prepareNativeJob({ ...trusted, native: { ...trusted.native, mcp: { tasks: { command: 'not-run', args: [] } } } }, params, context), /binding|MCP/i);
    for (const key of ['tools', 'skills', 'model', 'thinking', 'systemPrompt', 'resumeSessionId']) {
      assert.doesNotThrow(() => api.prepareNativeJob(trusted, { ...params, [key]: '   ' }, context));
    }
    assert.doesNotThrow(() => api.prepareNativeJob({ ...trusted, metadata: { ...trusted.metadata, 'session-mode': 'new' } }, params, context));
    const off = api.prepareNativeJob({ ...trusted, thinking: 'off' }, params, context);
    assert.equal(off.argv[off.argv.indexOf('--reasoning-effort') + 1], 'none');
    const shimDir = join(root, 'shims'); mkdirSync(shimDir);
    symlinkSync(executable, join(shimDir, 'copilot'));
    assert.equal(api.prepareNativeJob(trusted, params, { ...context, env: { ...context.env, PATH: shimDir } }).argv[2], join(shimDir, 'copilot'));
    const plan = api.prepareNativeJob(trusted, params, context);
    assert.deepEqual(plan.argv.slice(0, 5), ['/usr/bin/env', 'COPILOT_AUTO_UPDATE=false', executable, '--prefer-version', '1.0.106-3']);
    assert.deepEqual(plan.argv.slice(-5), ['--name', 'unique-name', '--trust-folder', '--prompt', params.task]);
    assert.ok(plan.argv.includes('--allow-tool=write'));
    assert.ok(plan.argv.includes('--deny-tool=shell'));
    assert.equal(plan.argv.includes('--resume'), false);
    const existing = api.prepareNativeJob({ ...trusted, native: { ...trusted.native, workspaceTrust: 'existing' } }, params, context);
    assert.equal(existing.argv.includes('--trust-folder'), false);
    assert.throws(() => api.prepareNativeJob({ ...trusted, model: 'github-copilot/gpt-6.1-sol' }, params, context), /native model|provider/i);
    assert.throws(() => api.prepareNativeJob({ ...trusted, tools: ['read'] }, params, context), /Pi tools/i);
    assert.throws(() => api.prepareNativeJob({ ...trusted, native: { ...trusted.native, runnerVersion: '9.9.9' } }, params, context), /not cached|install.*explicit/i);
    const taskPolicy = { ...trusted, native: { ...trusted.native, allow: ['write', 'shell', 'tasks(todo)'], deny: [], mcp: { tasks: {
      command: '{node}', args: ['{home}/.local/bin/pi-agent-tasks-mcp', '--scope-cwd', '{parentCwd}', '--store-override={env.PI_TODO_PATH}', '--actor', '{managedSessionId}', '--actions', 'get,claim,update,append,release'], env: { HOME: '{home}' },
    } } } };
    const bound = api.prepareNativeJob(taskPolicy, params, { ...context, env: { PATH: bin, HOME: root, PI_TODO_PATH: '' } });
    const config = JSON.parse(bound.argv[bound.argv.indexOf('--additional-mcp-config') + 1]);
    assert.deepEqual(config.mcpServers.tasks, { type: 'local', command: process.execPath, args: [join(root, '.local/bin/pi-agent-tasks-mcp'), '--scope-cwd', root, '--store-override=', '--actor', 'managed-1', '--actions', 'get,claim,update,append,release'], env: { HOME: root }, tools: ['*'] });
    assert.match(bound.argv.at(-1), /MCP server.*tasks.*todo/);
    const readonly = api.prepareNativeJob({ ...taskPolicy, native: { ...taskPolicy.native, allow: ['tasks(todo)'], deny: ['write', 'shell'] } }, { ...params, task: 'Read again' }, { ...context, resume: true });
    assert.ok(readonly.argv.includes('--deny-tool=write'));
    assert.ok(readonly.argv.includes('--deny-tool=shell'));
    assert.ok(!readonly.argv.includes('--allow-tool=write'));
    assert.ok(!readonly.argv.includes('--name'));
    assert.equal(readonly.argv[readonly.argv.indexOf('--resume') + 1], 'unique-name');
    assert.throws(() => api.prepareNativeJob({ ...taskPolicy, native: { ...taskPolicy.native, mcp: {} } }, params, context), /required.*tasks|tasks.*binding/i);
    assert.throws(() => api.prepareNativeJob(taskPolicy, params, { ...context, bindings: { parentCwd: '/wrong-scope', managedSessionId: 'managed-1', todoPathLiteral: '' } }), /scope mismatch/i);
    assert.throws(() => api.prepareNativeJob({ ...trusted, skills: ['large'] }, params, { ...context, skills: [{ name: 'large', baseDir: root, body: 'x'.repeat(61 * 1024) }] }), /60 KiB|truncated/);
    assert.throws(() => api.prepareNativeJob({ ...trusted, systemPrompt: { mode: 'replace', text: 'Not materializable' } }, params, context), /system-prompt mode/i);
    assert.equal(plan.context.env.PI_TODO_PATH, '../tasks');
    assert.equal(api.prepareNativeJob(trusted, params, { ...context, env: { PATH: bin, HOME: root } }).context.env.PI_TODO_PATH, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
