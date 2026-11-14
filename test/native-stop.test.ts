import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createAgentRunState } from 'pi-agent-execution';
import subagentsExtension, { __test__ } from '../pi-extension/subagents/index.ts';
import { createStatusState } from '../pi-extension/subagents/status.ts';
import { buildNativeCaptureCommand, probeNativeEntry } from '../pi-extension/subagents/native-job.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(fn: (f: any) => Promise<void>, live = false, natural = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-stop-')));
  const runId = 'stop-fixture';
  const endpoint = join(dir, 'core.sock');
  const paths = { stdout: join(dir, 'stdout'), stderr: join(dir, 'stderr'), status: join(dir, 'status') };
  const command = buildNativeCaptureCommand([process.execPath, '-e', live ? natural ? 'process.stdout.write("ready\\n");setTimeout(()=>{},100)' : 'process.stdout.write("ready\\n");setInterval(()=>{},1000)' : 'process.stdout.write("partial")'], paths, runId);
  const scriptPath = join(dir, 'capture.sh');
  writeFileSync(scriptPath, '#!/bin/bash\n' + command + '\n', { mode: 0o600 });
  const wrapper = live ? spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }) : undefined;
  const wrapperExit = wrapper ? once(wrapper, 'exit') : undefined;
  if (!wrapper) execFileSync('/bin/bash', ['-c', command]);
  const state: any = { preBusy: 0, rejectKill: 0, kills: 0, removes: 0, acceptedLive: false, unreachable: false, gets: 0, terminal: 'live', reason: 'exited' };
  const terminal = () => ({ address: 't2', parent: 't1', argv: ['/bin/bash', join(dir, 'capture.sh')], state: state.terminal, pid: wrapper?.pid ?? 12345,
    labels: { 'pi.subagent.run': runId }, exit_code: state.terminal === 'finished' ? (state.reportedExitCode ?? (state.realExit ? state.realExit[0] : 0)) : null, signal: state.realExit?.[1] ? constants.signals[state.realExit[1] as keyof typeof constants.signals] : null, reason: state.terminal === 'finished' ? state.reason : null });
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
        if (state.holdRead) {
          const held = state.holdRead;
          state.holdRead = undefined;
          state.readInFlight = true;
          await held;
          state.readInFlight = false;
        }
        if (state.delayReadMs) {
          const delay = state.delayReadMs;
          state.delayReadMs = 0;
          state.readInFlight = true;
          await wait(delay);
          state.readInFlight = false;
        }
      } else if (request.method === 'terminal.kill') {
        state.kills++;
        if (state.rejectKill-- > 0) return reject(state.rejectKind ?? 'busy');
        if (state.ambiguousKill-- > 0) return reject('transport');
        if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) {
          if (state.wholeGroup) process.kill(-wrapper.pid!, 'SIGKILL'); else wrapper.kill('SIGKILL');
          state.realExit = await wrapperExit;
          if (state.wholeGroup && !state.replyBeforeEntryReap) for (let i = 0; i < 100 && probeNativeEntry(paths, runId).state !== 'absent'; i++) await wait(10);
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
    await fn({ running, state, dir, paths, wrapper, wrapperExit, setPending(p: Promise<any>) { pending = p; } });
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
      const before = probeNativeEntry(paths, runId); // Real probe; never the injected EPERM/lag boundary.
      let cleanupGroupSignals = 0;
      assert.notEqual(before.state, 'unconfirmed', `cannot establish correlated fixture entry for cleanup: ${before.reason}`);
      if (before.state === 'alive') {
        process.kill(-wrapper.pid!, 'SIGKILL');
        cleanupGroupSignals++;
      }
      await wrapperExit;
      for (let i = 0; i < 200 && probeNativeEntry(paths, runId).state !== 'absent'; i++) await wait(10);
      assert.equal(probeNativeEntry(paths, runId).state, 'absent', 'fixture entry cleanup is proven');
      if (state.expectedCleanupSignals !== undefined) assert.equal(cleanupGroupSignals, state.expectedCleanupSignals, 'cleanup signals only a still-live correlated fixture group');
      if (process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR && state.cleanupEvidenceName) {
        const fs = await import('node:fs');
        fs.mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
        fs.writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, state.cleanupEvidenceName + '-cleanup.json'), JSON.stringify({ fixtureOnly: true, wrapperPid: wrapper.pid, entryBefore: before, cleanupGroupSignals, entryAfter: probeNativeEntry(paths, runId) }, null, 2));
      }
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
  state.expectedCleanupSignals = wholeGroup ? 0 : 1;
  state.cleanupEvidenceName = wholeGroup ? 'real-group-stop' : 'real-wrapper-stop';
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

for (const timing of ['ordinary session', 'production poll sleep', 'in-flight read', 'lagged entry reap'])
for (const mode of timing === 'lagged entry reap' ? ['whole-group'] : ['whole-group', 'wrapper-only', 'missing-pid', 'EPERM']) test(`${timing} shutdown of real pipeline: ${mode}`, async () => fixture(async ({ running, state, paths, wrapper, dir, setPending }: any) => {
  state.wholeGroup = mode !== 'wrapper-only';
  state.expectedCleanupSignals = mode === 'wrapper-only' ? 1 : 0;
  state.cleanupEvidenceName = 'shutdown-' + timing.replaceAll(' ', '-') + '-' + mode;
  const entry = JSON.parse(readFileSync(paths.status + '.entry.json', 'utf8'));
  const handlers = new Map<string, any>();
  subagentsExtension({
    events: { emit() {}, on() { return () => {}; } }, on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getAllTools() { return []; },
  } as any);
  handlers.get('session_start')({}, { cwd: dir });
  running.abortController = new AbortController();
  running.nativeStopTimeoutMs = timing === 'ordinary session' ? 1500 : 10000;
  if (timing === 'in-flight read') state.delayReadMs = 50;
  if (timing === 'lagged entry reap') state.replyBeforeEntryReap = true;
  let entryLagActive = false;
  let entryLagTimer: ReturnType<typeof setTimeout> | undefined;
  const watched = __test__.watchSubagent(running, running.abortController.signal, {
    visibleInterval: timing === 'ordinary session' ? 2 : 1000,
    processProbe(pid, signal) {
      assert.equal(pid, entry.pid, 'only the correlated known entry is probed');
      assert.equal(signal, 0, 'production boundary probes never terminate a PID');
      if (mode === 'EPERM') throw Object.assign(new Error('fixture denied'), { code: 'EPERM' });
      if (timing === 'lagged entry reap' && state.kills > 0 && state.terminal === 'finished') {
        if (entryLagTimer === undefined) {
          entryLagActive = true;
          entryLagTimer = setTimeout(() => { entryLagActive = false; state.lagReleasedAt = Date.now(); }, 20);
        }
        if (entryLagActive) { state.lagInjectedProbes = (state.lagInjectedProbes ?? 0) + 1; return; }
      }
      process.kill(pid, signal);
    },
  });
  if (timing === 'production poll sleep') {
    for (let i = 0; i < 100 && state.gets < 1; i++) await wait(10);
    assert.ok(state.gets >= 1, 'observer has read the live program');
    await wait(50); // Exact parent repro: enter production's existing one-second sleep.
  } else if (timing === 'in-flight read') {
    for (let i = 0; i < 100 && !state.readInFlight; i++) await wait(1);
    assert.equal(state.readInFlight, true, 'shutdown overlaps a delayed live read reply');
  }
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => { errors.push(args.join(' ')); };
  try {
    if (mode === 'missing-pid') rmSync(paths.status + '.entry.json');
    const shutdownStarted = Date.now();
    const shutdown = handlers.get('session_shutdown')({ reason: 'quit' }, {});
    const deadlineAtStop = running.nativeStopDeadline;
    setPending(Promise.all([watched, shutdown]));
    await shutdown;
    const result: any = await watched;
    const shutdownElapsedMs = Date.now() - shutdownStarted;
    assert.ok(shutdownElapsedMs < 2500, `shutdown stays near poll time, not the ten-second deadline: ${shutdownElapsedMs}ms`);
    assert.equal(state.kills, 1);
    assert.equal(running.nativeStopDeadline, deadlineAtStop, 'proof does not extend the existing stop deadline');
    assert.equal(existsSync(paths.status), false, 'a real kill has no final capture status');
    assert.ok(result.outputCapture, 'shutdown preserves a truthful partial capture');
    assert.equal(result.outputCapture.complete, false);
    assert.equal(readFileSync(paths.stdout, 'utf8'), 'ready\n', 'shutdown retains raw current-job output');
    if (mode === 'whole-group') {
      assert.deepEqual(errors, [], 'reachable shutdown with entry absence must finish cleanup');
      if (timing === 'lagged entry reap') {
        assert.ok(state.lagInjectedProbes > 0, 'the OS-probe boundary first reports known entry alive');
        assert.ok(state.lagReleasedAt !== undefined, 'closure waits for a new absence observation');
        assert.ok(shutdownElapsedMs < 1000, 're-probe remains capped, not the ten-second stop budget');
      }
      assert.equal(state.removes, 1);
      if (timing === 'production poll sleep' || timing === 'in-flight read') assert.equal(state.gets, 4, 'fresh proof uses cached finish, not a new read RPC');
      assert.equal(__test__.runningSubagents.has(running.id), false);
      assert.equal(running.coreCleanupError, undefined);
      assert.equal(running.nativeEntryProof.state, 'absent');
      assert.equal(result.projection.terminal, true);
      assert.ok(['aborted', 'terminated'].includes(result.completion.execution));
      assert.equal(result.completion.taskOutcome, 'unknown');
      assert.equal(result.completion.completionEvidence, undefined);
      // A partial-capture recovery receipt remains historical, not an active owner.
      const recovery = JSON.parse(readFileSync(join(dir, 'subagent-completion', running.id + '.recovery.json'), 'utf8'));
      assert.equal(recovery.runId, running.id);
      assert.equal(recovery.childPid, entry.pid);
    } else {
      assert.ok(errors.length > 0);
      assert.equal(state.removes, 0);
      assert.equal(__test__.runningSubagents.has(running.id), true);
      assert.notEqual(running.nativeState.process.status, 'exited');
      assert.equal(result.projection.terminal, false);
      assert.equal(result.completion, undefined);
      assert.equal(running.nativeEntryProof.state, mode === 'wrapper-only' ? 'alive' : 'unconfirmed');
      assert.equal(existsSync(join(dir, 'subagent-completion', running.id + '.recovery.json')), true);
    }
    if (process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR) {
      const fs = await import('node:fs');
      fs.mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, 'session-shutdown-' + timing.replaceAll(' ', '-') + '-' + mode + '.json'), JSON.stringify({ fixtureOnly: true, mode, timing, shutdownElapsedMs, lagInjectedProbes: state.lagInjectedProbes, replyBeforeEntryReap: state.replyBeforeEntryReap === true, readDelayed: timing === 'in-flight read', wrapperPid: wrapper.pid, wrapperExit: state.realExit, entry,
        entryProof: running.nativeEntryProof, kills: state.kills, removes: state.removes, coreGets: state.gets, cleanupErrors: errors,
        stopDeadlineUnchanged: running.nativeStopDeadline === deadlineAtStop, recoveryReceiptPresent: existsSync(join(dir, 'subagent-completion', running.id + '.recovery.json')),
        captureComplete: result.outputCapture.complete, process: running.nativeState.process, projection: result.projection,
        execution: result.completion?.execution, registered: __test__.runningSubagents.has(running.id) }, null, 2));
    }
  } finally {
    console.error = originalError;
    clearTimeout(entryLagTimer);
    if (mode === 'missing-pid') writeFileSync(paths.status + '.entry.json', JSON.stringify(entry), { mode: 0o600 });
  }
}, true));

for (const scenario of [
  { name: 'natural finish shutdown during production sleep', timing: 'sleep', reason: 'exited', valid: true },
  { name: 'natural finish shutdown during in-flight read', timing: 'in-flight', reason: 'exited', valid: true },
  { name: 'natural finish cached reason killed fails without success', timing: 'sleep', reason: 'killed', valid: false },
  { name: 'natural finish cached reason null fails without success', timing: 'sleep', reason: null, valid: false },
  { name: 'natural finish capture status mismatch stays unconfirmed', timing: 'sleep', reason: 'exited', mismatch: true, valid: false },
]) test(scenario.name, async () => fixture(async ({ running, state, paths, wrapper, wrapperExit, dir, setPending }: any) => {
  state.expectedCleanupSignals = 0;
  state.cleanupEvidenceName = scenario.name.replaceAll(' ', '-');
  const entry = JSON.parse(readFileSync(paths.status + '.entry.json', 'utf8'));
  let releaseRead: (() => void) | undefined;
  if (scenario.timing === 'in-flight') state.holdRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const handlers = new Map<string, any>();
  subagentsExtension({
    events: { emit() {}, on() { return () => {}; } }, on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getAllTools() { return []; },
  } as any);
  handlers.get('session_start')({}, { cwd: dir });
  running.nativeStopTimeoutMs = 10000;
  running.abortController = new AbortController();
  const watched = __test__.watchSubagent(running, running.abortController.signal, { visibleInterval: 1000 });
  setPending(watched);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => { errors.push(args.join(' ')); };
  try {
    for (let i = 0; i < 100 && state.gets < 1; i++) await wait(10);
    assert.ok(state.gets >= 1, 'observer read begins while the real entry is alive');
    assert.equal(probeNativeEntry(paths, running.runId).state, 'alive', 'real entry is still alive at the first live Core read');
    if (scenario.timing === 'sleep') await wait(50);
    else assert.equal(state.readInFlight, true);
    state.realExit = await wrapperExit;
    assert.deepEqual(state.realExit, [0, null], 'real pipeline finishes naturally');
    assert.equal(existsSync(paths.status), true);
    state.terminal = 'finished'; state.reason = scenario.reason;
    if (scenario.mismatch) state.reportedExitCode = 7;
    if (scenario.timing === 'in-flight') assert.equal(state.readInFlight, true, 'real natural exit occurs during delayed live reply');
    const getsBeforeStop = state.gets;
    const started = Date.now();
    const shutdown = handlers.get('session_shutdown')({ reason: 'quit' }, {});
    const deadlineAtStop = running.nativeStopDeadline;
    setPending(Promise.all([watched, shutdown]));
    if (scenario.timing === 'in-flight') {
      for (let i = 0; i < 100 && running.nativeHostTerminal?.state !== 'finished'; i++) await wait(1);
      assert.equal(running.nativeHostTerminal?.state, 'finished', 'stop read caches finished Core before the stale live reply');
      releaseRead!();
    }
    await shutdown;
    const result: any = await watched;
    const elapsedMs = Date.now() - started;
    assert.ok(elapsedMs < 2500);
    assert.equal(state.kills, 0);
    assert.equal(running.nativeState.control.status, 'none');
    assert.equal(running.nativeStopDeadline, deadlineAtStop);
    assert.equal(readFileSync(paths.stdout, 'utf8'), 'ready\n');
    if (scenario.valid) {
      assert.deepEqual(errors, [], 'natural finish during detached observation must close cleanly');
      assert.equal(state.removes, 1);
      assert.equal(__test__.runningSubagents.has(running.id), false);
      assert.equal(running.coreCleanupError, undefined);
      assert.equal(result.outputCapture.complete, true);
      assert.equal(result.completion.execution, 'normal-exit');
      assert.equal(result.completion.taskOutcome, 'unknown');
      assert.equal(result.error, undefined);
      assert.equal(result.projection.terminal, true);
      assert.equal(state.gets, getsBeforeStop + 2, 'only stop read and removal verify Core; fresh proof has no get RPC');
    } else if (scenario.mismatch) {
      assert.ok(errors.length > 0);
      assert.equal(state.removes, 0, 'status/Core mismatch remains owned');
      assert.equal(__test__.runningSubagents.has(running.id), true);
      assert.notEqual(result.completion?.execution, 'normal-exit');
      assert.equal(existsSync(join(dir, 'subagent-completion', running.id + '.recovery.json')), true);
    } else {
      // Accepted full-capture semantics: unknown reason is a terminal failure, not success.
      // The owner's first rejection may leave a historical warning before watcher cleanup.
      assert.equal(state.removes, 1);
      assert.equal(__test__.runningSubagents.has(running.id), false);
      assert.equal(result.outputCapture.complete, true);
      assert.equal(result.projection.disposition, 'transport-failed');
      assert.equal(result.projection.terminal, true);
      assert.equal(result.exitCode, 1);
      assert.notEqual(result.completion.execution, 'normal-exit');
      assert.equal(result.completion.completionEvidence, undefined);
      assert.equal(result.completion.taskOutcome, 'unknown');
    }
    if (process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR) {
      const fs = await import('node:fs');
      fs.mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, state.cleanupEvidenceName + '.json'), JSON.stringify({ fixtureOnly: true, scenario: scenario.name, wrapperPid: wrapper.pid, wrapperExit: state.realExit, entry,
        kills: state.kills, removes: state.removes, getsBeforeStop, getsAfterStop: state.gets, elapsedMs, cleanupErrors: errors,
        control: running.nativeState.control, stopDeadlineUnchanged: running.nativeStopDeadline === deadlineAtStop,
        captureComplete: result.outputCapture?.complete, execution: result.completion?.execution, exitCode: result.exitCode, error: result.error,
        completionEvidence: result.completion?.completionEvidence, taskOutcome: result.completion?.taskOutcome, projection: result.projection,
        registered: __test__.runningSubagents.has(running.id) }, null, 2));
    }
  } finally { releaseRead?.(); console.error = originalError; }
}, true, true));

test('racing stop preserves already finished natural completion without a new control cause', async () => fixture(async ({ running, state }: any) => {
  state.terminal = 'finished';
  const result: any = await __test__.handleSubagentTerminate({ id: running.id });
  assert.equal(result.details.status, 'exited');
  assert.equal(running.nativeState.control.status, 'none');
  assert.equal(state.kills, 0);
}));
