import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as capture from '../pi-extension/subagents/native-job.ts';

test('real long-running foreground pipeline distinguishes wrapper death from native entry closure', async () => {
  const api = capture as any;
  assert.equal(typeof api.probeNativeEntry, 'function');
  const root = mkdtempSync(join(tmpdir(), 'native-entry-'));
  const paths = { stdout: join(root, 'stdout'), stderr: join(root, 'stderr'), status: join(root, 'status') };
  const command = api.buildNativeCaptureCommand([process.execPath, '-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], paths, 'live-fixture');
  const wrapper = spawn('/bin/bash', ['-c', command], { detached: true, stdio: 'ignore' });
  const exited = once(wrapper, 'exit');
  let entry: any;
  let groupStopProven = false;
  try {
    for (let i = 0; i < 200 && !existsSync(paths.status + '.entry.json'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(paths.status + '.entry.json'), true);
    entry = JSON.parse(readFileSync(paths.status + '.entry.json', 'utf8'));
    assert.equal(entry.runId, 'live-fixture');
    assert.equal(statSync(paths.status + '.entry.json').mode & 0o777, 0o600);
    assert.notEqual(entry.pid, wrapper.pid);
    const liveProof = api.probeNativeEntry(paths, 'live-fixture');
    assert.equal(liveProof.state, 'alive', JSON.stringify(liveProof));
    assert.equal(api.probeNativeEntry(paths, 'wrong-run').state, 'unconfirmed');
    assert.equal(api.probeNativeEntry(paths, 'live-fixture', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }).state, 'unconfirmed');
    for (let i = 0; i < 200 && !readFileSync(paths.stdout, 'utf8').includes('ready'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(readFileSync(paths.stdout, 'utf8'), /ready/);
    wrapper.kill('SIGKILL'); // Only this fixture-owned capture wrapper.
    await exited;
    assert.equal(api.probeNativeEntry(paths, 'live-fixture').state, 'alive', 'wrapper finish does not close its native entry');
    process.kill(-wrapper.pid!, 'SIGKILL'); // Only the detached group created above.
    for (let i = 0; i < 200 && api.probeNativeEntry(paths, 'live-fixture').state !== 'absent'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(api.probeNativeEntry(paths, 'live-fixture').state, 'absent');
    groupStopProven = true;
    assert.equal(existsSync(paths.status), false, 'a real kill has no completed capture status');
    const partial = api.readNativePartialCapture(paths);
    assert.equal(partial.capture.complete, false);
    if (process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR) {
      const fs = await import('node:fs');
      fs.mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, 'real-pipeline.json'), JSON.stringify({ fixtureOnly: true, wrapperPid: wrapper.pid, entry, wrapperOnlyEntryState: 'alive', groupStopEntryState: api.probeNativeEntry(paths, 'live-fixture').state, captureStatusPresent: existsSync(paths.status) }, null, 2));
    }
  } finally {
    const before = api.probeNativeEntry(paths, 'live-fixture');
    let cleanupGroupSignals = 0;
    assert.notEqual(before.state, 'unconfirmed', `cannot establish correlated fixture entry for cleanup: ${before.reason}`);
    if (before.state === 'alive') {
      process.kill(-wrapper.pid!, 'SIGKILL');
      cleanupGroupSignals++;
    }
    await exited;
    for (let i = 0; i < 200 && api.probeNativeEntry(paths, 'live-fixture').state !== 'absent'; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(api.probeNativeEntry(paths, 'live-fixture').state, 'absent');
    if (groupStopProven) assert.equal(cleanupGroupSignals, 0, 'proven stopped group is not signaled a second time');
    if (process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR) {
      const fs = await import('node:fs');
      fs.mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, 'real-pipeline-cleanup.json'), JSON.stringify({ fixtureOnly: true, entryBefore: before, cleanupGroupSignals, entryAfter: api.probeNativeEntry(paths, 'live-fixture') }, null, 2));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('foreground current-job capture retains complete private stdout with a bounded Unicode model view', () => {
  const api = capture as any;
  assert.equal(typeof api.buildNativeCaptureCommand, 'function');
  const root = mkdtempSync(join(tmpdir(), 'native-capture-'));
  try {
    const paths = { stdout: join(root, 'stdout'), stderr: join(root, 'stderr'), status: join(root, 'status') };
    const text = '€'.repeat(30_000) + '\n'.repeat(400);
    const argv = [process.execPath, '-e', `process.stdout.write(${JSON.stringify(text)});process.stderr.write('diagnostic');`];
    const command = api.buildNativeCaptureCommand(argv, paths, 'run-1');
    const streamed = execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8' });
    assert.equal(streamed, text);
    assert.equal(readFileSync(paths.stdout, 'utf8'), text);
    assert.equal(statSync(paths.stdout).mode & 0o777, 0o600);
    const result = api.readNativeCapture(paths, 'run-1');
    assert.equal(result.capture.source, 'current-job-stdout');
    assert.equal(result.capture.complete, true);
    assert.equal(result.capture.truncated, true);
    assert.equal(result.capture.bytes, Buffer.byteLength(text));
    assert.ok(Buffer.byteLength(result.output) <= 65536);
    assert.equal(result.output.includes('�'), false);
    assert.equal(result.diagnostic, 'diagnostic');
    assert.equal(result.capture.diagnosticTruncated, false);
    assert.equal(result.capture.diagnosticLimitBytes, 8192);
    assert.throws(() => api.readNativeCapture(paths, 'wrong-run'), /correlat|run/i);
    assert.throws(() => execFileSync('/bin/bash', ['-c', command], { stdio: 'pipe' }));
    assert.equal(readFileSync(paths.stdout, 'utf8'), text, 'exclusive creation preserves the original capture');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
