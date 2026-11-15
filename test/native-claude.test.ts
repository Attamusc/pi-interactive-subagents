import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildNativeCaptureCommand, prepareNativeJob, readNativeCapture, probeNativeEntry } from '../pi-extension/subagents/native-job.ts';

test('Claude native jobs bind explicit policy, existing trust and a stable UUID on resume', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-claude-')));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "2.1.325 (Claude Code)\\n"\n', { mode: 0o700 });
    writeFileSync(join(root, '.claude.json'), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
    const definition: any = { name: 'coding', runner: 'claude', model: 'sonnet', thinking: 'low',
      origin: { kind: 'global-user', canonicalPath: join(root, 'coding.md'), canonicalRoot: root },
      systemPrompt: { text: 'Implement the task.' }, metadata: { 'auto-exit': true, interactive: false },
      native: { runnerVersion: '2.1.325', workspaceTrust: 'existing', nativeTools: ['Read', 'Edit', 'Write', 'Bash'],
        permissionMode: 'manual', allow: ['Read', 'Edit', 'Write', 'Bash'], deny: ['Agent'], mcp: {} } };
    const params = { name: 'coding', task: 'Make the change.' };
    const context = { parentCwd: root, managedSessionId: 'actor', nativeName: 'a1234567-1234-4567-8123-123456789abc', env: { HOME: root, PATH: bin, PI_TODO_PATH: '../literal' } };
    const coding = prepareNativeJob(definition, params, context);
    assert.equal(coding.nativeReference.runner, 'claude');
    assert.equal(coding.nativeReference.selector.kind, 'uuid');
    assert.equal(coding.argv[coding.argv.indexOf('--session-id') + 1], context.nativeName);
    assert.equal(coding.argv[coding.argv.indexOf('--permission-mode') + 1], 'manual');
    assert.equal(coding.argv[coding.argv.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(coding.argv[coding.argv.indexOf('--tools') + 1], 'Read,Edit,Write,Bash');
    assert.equal(coding.argv[coding.argv.indexOf('--setting-sources') + 1], '');
    assert.ok(coding.argv.includes('--strict-mcp-config'));
    assert.equal(coding.argv.includes('--safe-mode'), false, 'safe mode also suppresses explicitly configured MCP');
    assert.ok(coding.argv.includes('CLAUDE_CODE_DISABLE_CLAUDE_MDS=1'));
    assert.deepEqual(JSON.parse(coding.argv[coding.argv.indexOf('--settings') + 1]), { disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true });
    assert.ok(!coding.argv.some(arg => arg.includes('skip-permissions')));
    assert.equal(coding.context.env.PI_TODO_PATH, '../literal');
    const readonly = prepareNativeJob({ ...definition, systemPrompt: { text: 'Read only. Do not edit.' }, native: {
      ...definition.native, nativeTools: ['Read', 'Glob', 'Grep'], permissionMode: 'dontAsk', allow: ['Read'], deny: ['Edit', 'Write', 'Bash'],
    } }, { ...params, task: 'Review the change.' }, { ...context, resume: true });
    assert.deepEqual(readonly.nativeReference, coding.nativeReference);
    assert.equal(readonly.argv[readonly.argv.indexOf('--resume') + 1], context.nativeName);
    assert.equal(readonly.argv.includes('--session-id'), false);
    assert.equal(readonly.argv[readonly.argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.equal(readonly.argv[readonly.argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(readonly.argv[readonly.argv.indexOf('--permission-prompts') + 1], 'none');
    assert.deepEqual(readonly.argv.flatMap((arg, i) => arg === '--disallowedTools' ? [readonly.argv[i + 1]] : []), ['Edit', 'Write', 'Bash']);
    assert.equal(readonly.argv[readonly.argv.indexOf('--system-prompt-snapshot') + 1], 'off');
    assert.equal(readonly.argv[readonly.argv.indexOf('--append-system-prompt') + 1], 'Read only. Do not edit.');
    for (const key of ['tools', 'skills', 'model', 'thinking', 'systemPrompt', 'resumeSessionId']) {
      assert.throws(() => prepareNativeJob(definition, { ...params, [key]: 'override' }, context), /overrides/);
    }
    assert.throws(() => prepareNativeJob({ ...definition, origin: undefined }, params, context), /origin|trusted/i);
    assert.throws(() => prepareNativeJob({ ...definition, native: { ...definition.native, runnerVersion: '2.1.324' } }, params, context), /runner-version/);
    assert.throws(() => prepareNativeJob({ ...definition, native: { ...definition.native, workspaceTrust: 'session' } }, params, context), /existing workspace trust/);
    assert.throws(() => prepareNativeJob(definition, params, { ...context, nativeName: 'name' }), /UUID/);
    const taskDefinition = { ...definition, native: { ...definition.native, allow: ['Read', 'mcp__tasks__todo'], mcp: { tasks: {
      command: '{node}', args: ['{home}/.local/bin/pi-agent-tasks-mcp', '--scope-cwd', '{parentCwd}', '--store-override={env.PI_TODO_PATH}', '--actor', '{managedSessionId}', '--actions', 'get,claim,update,append,release'], env: { HOME: '{home}' },
    } } } };
    const taskJob = prepareNativeJob(taskDefinition, params, context);
    const server = JSON.parse(taskJob.argv[taskJob.argv.indexOf('--mcp-config') + 1]).mcpServers.tasks;
    assert.equal(server.type, 'stdio');
    assert.equal(server.command, process.execPath);
    assert.equal(server.env.HOME, root);
    assert.ok(server.args.includes('--store-override=../literal'));
    assert.equal(server.args[server.args.indexOf('--actor') + 1], 'actor');
    assert.equal(server.args[server.args.indexOf('--scope-cwd') + 1], root);
    assert.throws(() => prepareNativeJob({ ...taskDefinition, native: { ...taskDefinition.native, mcp: {} } }, params, context), /Required tasks MCP/);
    for (const flag of ['--allow-force', '--allow-force=true', '--force']) {
      const server = taskDefinition.native.mcp.tasks;
      assert.throws(() => prepareNativeJob({ ...taskDefinition, native: { ...taskDefinition.native, mcp: { tasks: { ...server, args: [...server.args, flag] } } } }, params, context), /no assignment-force/);
    }
    const invalidActions = taskDefinition.native.mcp.tasks.args.map(arg => arg === 'get,claim,update,append,release' ? 'get,break-stale-lock' : arg);
    assert.throws(() => prepareNativeJob({ ...taskDefinition, native: { ...taskDefinition.native, mcp: { tasks: { ...taskDefinition.native.mcp.tasks, args: invalidActions } } } }, params, context), /supported actions/);
    for (const tool of ['default', '*', 'Unknown', 'Agent']) assert.throws(() => prepareNativeJob({ ...definition, native: { ...definition.native, nativeTools: [tool] } }, params, context), /Unsupported Claude native-tools/);
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_IGNORE_PERSISTED_TRUST']) assert.throws(() => prepareNativeJob(definition, params, { ...context, env: { ...context.env, [key]: 'override' } }), /trust.*override/);
    assert.ok(coding.argv.includes(`HOME=${root}`));
    for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_IGNORE_PERSISTED_TRUST']) {
      const runtime = spawnSync(coding.argv[0], coding.argv.slice(1), { env: { HOME: root, PATH: bin, [key]: '/core-only-override' }, encoding: 'utf8', timeout: 5000 });
      assert.equal(runtime.status, 78);
      assert.equal(runtime.stdout, '');
      assert.match(runtime.stderr, /Unsupported Claude runtime trust override/);
    }
    const runtime = spawnSync(coding.argv[0], coding.argv.slice(1), { env: { HOME: root, PATH: bin }, encoding: 'utf8', timeout: 5000 });
    assert.equal(runtime.status, 0);
    assert.equal(runtime.stdout.trim(), '2.1.325 (Claude Code)');
    const capture = { stdout: join(root, 'guard.stdout'), stderr: join(root, 'guard.stderr'), status: join(root, 'guard.status') };
    const captured = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', buildNativeCaptureCommand(coding.argv, capture, 'claude-guard')], {
      env: { HOME: root, PATH: bin, CLAUDE_CONFIG_DIR: '/core-only-override' }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(captured.status, 78);
    const result = readNativeCapture(capture, 'claude-guard');
    assert.equal(result.nativeExit, 78);
    assert.equal(result.output, '');
    assert.match(result.diagnostic, /Unsupported Claude runtime trust override/);
    assert.equal(probeNativeEntry(capture, 'claude-guard').state, 'absent');
    const repo = join(root, 'repo'); mkdirSync(repo);
    assert.equal(spawnSync('/usr/bin/git', ['init', repo]).status, 0);
    const child = join(repo, 'src'); mkdirSync(child);
    const store = join(root, '.claude.json');
    const persisted = JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } });
    writeFileSync(store, persisted);
    for (const resume of [false, false, true]) {
      const job = prepareNativeJob(definition, { ...params, cwd: child }, { ...context, resume });
      assert.equal(job.cwd, child);
      assert.ok(job.argv.includes(resume ? '--resume' : '--session-id'));
      assert.equal(readFileSync(store, 'utf8'), persisted);
    }
    const nested = join(child, 'nested'); mkdirSync(nested);
    assert.equal(spawnSync('/usr/bin/git', ['init', nested]).status, 0);
    const nestedChild = join(nested, 'src'); mkdirSync(nestedChild);
    for (const cwd of [nested, nestedChild]) assert.throws(() => prepareNativeJob(definition, { ...params, cwd }, context), /existing trusted workspace/);
    const worktree = join(child, 'worktree'); mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), 'gitdir: /missing/worktree\n');
    assert.throws(() => prepareNativeJob(definition, { ...params, cwd: worktree }, context), /existing trusted workspace/);
    const linked = join(child, 'linked-worktree');
    assert.equal(spawnSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']).status, 0);
    assert.equal(spawnSync('/usr/bin/git', ['-C', repo, 'worktree', 'add', '-b', 'fixture', linked]).status, 0);
    const linkedChild = join(linked, 'src'); mkdirSync(linkedChild);
    assert.throws(() => prepareNativeJob(definition, { ...params, cwd: linkedChild }, context), /existing trusted workspace/);
    writeFileSync(store, JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true }, [linked]: { hasTrustDialogAccepted: true } } }));
    assert.equal(prepareNativeJob(definition, { ...params, cwd: linkedChild }, context).cwd, linkedChild);
    writeFileSync(store, persisted);
    const outside = join(root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(child, 'escape'));
    assert.throws(() => prepareNativeJob(definition, { ...params, cwd: join(child, 'escape') }, context), /existing trusted workspace/);
    writeFileSync(store, JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
    assert.throws(() => prepareNativeJob(definition, { ...params, cwd: outside }, context), /existing trusted workspace/, 'non-repository ancestor trust is not inferred');
    assert.throws(() => prepareNativeJob(definition, { ...params, cwd: child }, context), /existing trusted workspace/, 'trust above repository boundary is not inferred');
    for (const malformed of ['{', 'null', '[]', '{"projects":[]}', JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: 'true' } } })]) {
      writeFileSync(store, malformed);
      assert.throws(() => prepareNativeJob(definition, { ...params, cwd: child }, context), /existing trusted workspace/);
    }
    writeFileSync(join(root, '.claude.json'), '{}');
    assert.throws(() => prepareNativeJob(definition, params, context), /existing trusted workspace/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
