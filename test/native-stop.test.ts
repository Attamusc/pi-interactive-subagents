import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createAgentRunState } from 'pi-agent-execution';
import { __test__ } from '../pi-extension/subagents/index.ts';
import { createStatusState } from '../pi-extension/subagents/status.ts';
import { buildNativeCaptureCommand, probeNativeEntry } from '../pi-extension/subagents/native-job.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(fn: (f: any) => Promise<void>, live = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-stop-')));
  const runId = 'stop-fixture';
  const endpoint = join(dir, 'core.sock');
  const paths = { stdout: join(dir, 'stdout'), stderr: join(dir, 'stderr'), status: join(dir, 'status') };
  const command = buildNativeCaptureCommand([process.execPath, '-e', live ? 'process.stdout.write("ready\\n");setInterval(()=>{},1000)' : 'process.stdout.write("partial")'], paths, runId);
  const scriptPath = join(dir, 'capture.sh');
  writeFileSync(scriptPath, '#!/bin/bash\n' + command + '\n', { mode: 0o600 });
  const wrapper = live ? spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }) : undefined;
  const wrapperExit = wrapper ? once(wrapper, 'exit') : undefined;
  if (!wrapper) execFileSync('/bin/bash', ['-c', command]);
  const state: any = { preBusy: 0, rejectKill: 0, kills: 0, removes: 0, acceptedLive: false, unreachable: false, gets: 0, terminal: 'live', reason: 'exited' };
  const terminal = () => ({ address: 't2', parent: 't1', argv: ['/bin/bash', join(dir, 'capture.sh')], state: state.terminal, pid: wrapper?.pid ?? 12345,
    labels: { 'pi.subagent.run': runId }, exit_code: state.terminal === 'finished' ? (state.realExit ? state.realExit[0] : 0) : null, signal: state.realExit?.[1] ? constants.signals[state.realExit[1] as keyof typeof constants.signals] : null, reason: state.terminal === 'finished' ? state.reason : null });
  const server = createServer(socket => {
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer);
      const reject = (kind: string) => socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture ' + kind, data: { kind } } }) + '\n');
      let result: any;
      if (request.method === 'hello') result = { generation: 1, core: { id: 'fixture-core' }, methods: ['terminal.run','terminal.get','terminal.list','terminal.read','terminal.keys','terminal.kill','terminal.rm'] };
      else if (request.method === 'terminal.get') {
        state.gets++;
        if (state.preBusy-- > 0) return reject('busy');
        if (state.unreachable && state.kills > 0) return reject('transport');
        result = terminal();
      } else if (request.method === 'terminal.kill') {
        state.kills++;
        if (state.rejectKill-- > 0) return reject(state.rejectKind ?? 'busy');
        if (state.ambiguousKill-- > 0) return reject('transport');
        if (wrapper) {
          if (state.wholeGroup) process.kill(-wrapper.pid!, 'SIGKILL'); else wrapper.kill('SIGKILL');
          state.realExit = await wrapperExit;
          if (state.wholeGroup) for (let i = 0; i < 100 && probeNativeEntry(paths, runId).state !== 'absent'; i++) await wait(10);
        }
        if (!state.acceptedLive) { state.terminal = 'finished'; state.reason = 'killed'; }
        result = terminal();
      } else if (request.method === 'terminal.rm') { state.removes++; result = { removed: 't2' }; }
      else throw new Error('unexpected ' + request.method);
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
  });
  const running: any = { id: runId, runId, name: 'Stop fixture', task: 'fake only', cli: 'copilot', sessionFile: '', transcriptStartLine: 0,
    artifactDir: dir, startTime: Date.now(), surface: 't2', interactive: false, canSpawnDirectChildren: false,
    statusState: createStatusState({ source: 'pi', startTimeMs: Date.now() }), nativeState: createAgentRunState(runId, 'native-job'),
    nativeCapturePaths: paths, nativePollInterval: 2, nativeStopTimeoutMs: live ? 1500 : 200,
    nativeJob: { nativeReference: { runner: 'copilot', managedSessionId: 'managed-stop', selector: { kind: 'name', value: 'native-stop' }, cwd: dir } },
    coreHost: { kind: 'herdr-core', endpoint, coreId: 'fixture-core', parent: 't1', address: 't2', runId, scriptPath: join(dir, 'capture.sh'), wrapperStartFile: join(dir, 'start.json'), wrapperPid: wrapper?.pid ?? 12345 } };
  let pending: Promise<any> | undefined;
  try {
    if (wrapper) {
      for (let i = 0; i < 200 && (!existsSync(paths.stdout) || !readFileSync(paths.stdout, 'utf8').includes('ready')); i++) await wait(10);
      assert.match(readFileSync(paths.stdout, 'utf8'), /ready/);
    }
    server.listen(endpoint); await once(server, 'listening');
    __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
    await fn({ running, state, dir, paths, wrapper, setPending(p: Promise<any>) { pending = p; } });
    if (state.evidenceName && process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR) {
      const fs = await import('node:fs');
      fs.mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, state.evidenceName + '.json'), JSON.stringify({ fixtureOnly: true, kills: state.kills, removes: state.removes, gets: state.gets,
        process: running.nativeState.process, control: running.nativeState.control, ambiguousSentKill: running.nativeKillAmbiguous === true, nativeEntry: running.nativeEntryProof,
        registered: __test__.runningSubagents.has(runId), recoveryPresent: existsSync(join(dir, 'subagent-completion', runId + '.recovery.json')) }, null, 2));
    }
  } finally {
    // Release only fixture observations, including the deliberately unbounded pre-fix implementation.
    state.unreachable = false; state.acceptedLive = false; state.terminal = 'finished'; state.reason = 'exited';
    if (pending) await Promise.race([pending.catch(() => {}), wait(1000)]);
    __test__.releaseRunningSubagent(runId);
    if (wrapper) {
      try { process.kill(-wrapper.pid!, 'SIGKILL'); } catch (error) { if ((error as any).code !== 'ESRCH') throw error; }
      await wrapperExit;
      for (let i = 0; i < 200 && probeNativeEntry(paths, runId).state !== 'absent'; i++) await wait(10);
      assert.equal(probeNativeEntry(paths, runId).state, 'absent', 'fixture entry cleanup is proven');
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const mode of ['precheck', 'busy', 'rpc_error', 'invalid_params']) test(`native stop retries ${mode} failure without poisoning the owner`, async () => fixture(async ({ running, state }: any) => {
  state[mode === 'precheck' ? 'preBusy' : 'rejectKill'] = 1;
  state.rejectKind = mode;
  state.evidenceName = 'stop-retry-' + mode;
  const first: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(first.details.error, 'termination-unconfirmed');
  const second: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(second.details.status, 'terminated');
  assert.equal(state.kills, mode === 'precheck' ? 1 : 2);
  assert.equal(state.removes, 1);
}));

test('an ambiguous sent kill is reconciled on the next stop without resending', async () => fixture(async ({ running, state }: any) => {
  state.ambiguousKill = 1;
  state.evidenceName = 'stop-sent-ambiguous-reconcile';
  const first: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(first.details.error, 'termination-unconfirmed');
  state.terminal = 'finished';
  const second: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(second.details.status, 'terminated');
  assert.equal(state.kills, 1);
  assert.equal(state.removes, 1);
}));

test('native stop and shutdown are bounded when an accepted stop cannot be observed', async () => fixture(async ({ running, state, dir, setPending }: any) => {
  state.acceptedLive = true; state.unreachable = true;
  state.evidenceName = 'stop-bounded-unreachable';
  const pending = __test__.handleSubagentTerminate({ id: running.id }); setPending(pending);
  const result: any = await Promise.race([pending, wait(350).then(() => null)]);
  assert.notEqual(result, null, 'stop must return unconfirmed within its owner budget');
  assert.equal(result.details.error, 'termination-unconfirmed');
  assert.equal(__test__.runningSubagents.has(running.id), true);
  assert.equal(state.kills, 1);
  assert.equal(state.removes, 0);
  assert.equal(existsSync(join(dir, 'subagent-completion', running.id + '.recovery.json')), true);
  const shutdown = __test__.shutdownOwnedSubagents('fixture shutdown'); setPending(shutdown);
  assert.notEqual(await Promise.race([shutdown, wait(350).then(() => null)]), null);
  const gets = state.gets;
  await wait(50);
  assert.equal(state.gets, gets, 'old-module polling stops after shutdown');
}));

for (const wholeGroup of [false, true]) test(`real fake-native pipeline stop: ${wholeGroup ? 'whole group proves known entry absent' : 'wrapper only retains live native entry'}`, async () => fixture(async ({ running, state, paths, wrapper, dir }: any) => {
  state.wholeGroup = wholeGroup;
  const entry = JSON.parse(readFileSync(paths.status + '.entry.json', 'utf8'));
  const result: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(state.kills, 1);
  assert.equal(existsSync(paths.status), false, 'killed real pipeline cannot fabricate complete capture');
  assert.equal(running.nativePartialCapture.capture.complete, false);
  if (wholeGroup) {
    assert.equal(result.details.status, 'terminated');
    assert.ok(result.details.outputCapture, 'stop reports its partial capture');
    assert.equal(result.details.outputCapture.complete, false);
    assert.match(result.content[0].text, /incomplete|partial/i);
    assert.equal(running.nativeEntryProof.state, 'absent');
    assert.equal(state.removes, 1);
    assert.equal(__test__.runningSubagents.has(running.id), false);
  } else {
    assert.equal(result.details.error, 'termination-unconfirmed');
    assert.equal(running.nativeEntryProof.state, 'alive');
    assert.notEqual(running.nativeState.process.status, 'exited');
    assert.equal(state.removes, 0);
    assert.equal(__test__.runningSubagents.has(running.id), true);
    const recovery = JSON.parse(readFileSync(join(dir, 'subagent-completion', running.id + '.recovery.json'), 'utf8'));
    assert.equal(recovery.childPid, entry.pid);
    const observed: any = await __test__.watchSubagent(running, new AbortController().signal, { visibleInterval: 2 });
    assert.equal(observed.projection.terminal, false);
    assert.equal(observed.completion, undefined);
    assert.equal(observed.exitCode, 1);
    assert.match(__test__.resolveResultPresentation(observed, running.name).split('\n')[0], /closure unconfirmed/);
    assert.equal(state.kills, 1);
    assert.equal(state.removes, 0);
  }
  if (process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR) {
    const fs = await import('node:fs');
    fs.mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, wholeGroup ? 'real-group-stop.json' : 'real-wrapper-stop.json'), JSON.stringify({ fixtureOnly: true, wrapperPid: wrapper.pid, wrapperExit: state.realExit, entry, entryProof: running.nativeEntryProof, kills: state.kills, removes: state.removes, process: running.nativeState.process, captureComplete: running.nativePartialCapture.capture.complete, registered: __test__.runningSubagents.has(running.id) }, null, 2));
  }
}, true));

for (const proof of ['missing', 'EPERM', 'EPERM-with-status']) test(`native ${proof} entry evidence remains unconfirmed after wrapper finish`, async () => fixture(async ({ running, state, paths }: any) => {
  if (proof !== 'EPERM-with-status') rmSync(paths.status);
  if (proof === 'missing') rmSync(paths.status + '.entry.json');
  else running.nativeProcessProbe = () => { throw Object.assign(new Error('fixture denied'), { code: 'EPERM' }); };
  const result: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(result.details.error, 'termination-unconfirmed');
  assert.notEqual(running.nativeState.process.status, 'exited');
  assert.equal(state.removes, 0);
}));

test('shutdown detaches the existing observer with bounded uncertainty rather than leaving old polling alive', async () => fixture(async ({ running, state, setPending }: any) => {
  state.acceptedLive = true; state.unreachable = true;
  state.evidenceName = 'stop-shutdown-detaches-observer';
  running.abortController = new AbortController();
  const watched = __test__.watchSubagent(running, running.abortController.signal, { visibleInterval: 2 });
  const shutdown = __test__.shutdownOwnedSubagents('fixture module teardown');
  const settled = Promise.all([watched, shutdown]); setPending(settled);
  const result: any = await Promise.race([settled, wait(350).then(() => null)]);
  assert.notEqual(result, null);
  assert.equal(result[1].length, 1, 'uncertain shutdown reports its recovery descriptor');
  const gets = state.gets;
  await wait(50);
  assert.equal(state.gets, gets);
  assert.equal(state.kills, 1);
  assert.equal(state.removes, 0);
}));

test('racing stop preserves already finished natural completion without a new control cause', async () => fixture(async ({ running, state }: any) => {
  state.terminal = 'finished';
  const result: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(result.details.status, 'exited');
  assert.equal(running.nativeState.control.status, 'none');
  assert.equal(state.kills, 0);
}));
