import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as capture from '../pi-extension/subagents/native-job.ts';

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
