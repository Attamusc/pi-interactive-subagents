import { it } from "node:test";
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { execFileSync } from "node:child_process";
import { createHash } from 'node:crypto';
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { waitForVisibleCompletion } from "../pi-extension/subagents/completion-watch.ts";
import { createChildCompletionRecorder } from "../pi-extension/subagents/completion.ts";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { getDirectChildCount } from "../pi-extension/subagents/ownership.ts";
import { getMuxBackend, muxSetupHint } from "../pi-extension/subagents/cmux.ts";
import { readNativeCapture } from '../pi-extension/subagents/native-job.ts';
import { prepareCoreLaunch, launchPreparedCoreRun } from "../pi-extension/subagents/core-launch.ts";

for (const scenario of [
  { name: 'classic default with Core available', mux: 'default', reason: 'exited', disposition: 'completed' },
  { name: 'blank override with Core available', mux: 'blank', reason: 'exited', disposition: 'completed' },
  { name: 'explicit classic override', mux: 'herdr', rejected: /Native jobs require the herdr-core backend/ },
  { name: 'unknown override with only Core available', mux: 'unknown-core', expectedBackend: 'herdr-core', rejected: /Native jobs require the herdr-core backend/ },
  { name: 'classic default without Core context', mux: 'missing-core', rejected: /HC_TERMINAL_SOCKET and HC_TERMINAL_ID required/ },
  { name: 'natural zero exit', reason: 'exited', disposition: 'completed' },
  { name: 'bounded Unicode output', unicodeOutput: true, reason: 'exited', disposition: 'completed' },
  { name: 'complete private stdout beyond 200 lines', longOutput: true, reason: 'exited', disposition: 'completed' },
  { name: 'observation timeout then natural exit', timeout: true, reason: 'exited', disposition: 'completed' },
  { name: 'busy once then natural exit', transient: 'busy', reason: 'exited', disposition: 'completed' },
  { name: 'transport once then natural exit', transient: 'transport', reason: 'exited', disposition: 'completed' },
  { name: 'invalid reply once then natural exit', transient: 'invalid_reply', reason: 'exited', disposition: 'completed' },
  { name: 'capture read once then natural exit', readOnce: true, reason: 'exited', disposition: 'completed' },
  { name: 'five transient capture read failures', readFailures: 5, reason: 'exited', disposition: 'completed' },
  { name: 'abnormal exit', code: 7, reason: 'exited', disposition: 'abnormal-exit' },
  { name: 'signal exit', signal: 9, reason: 'exited', disposition: 'abnormal-exit' },
  { name: 'lost live observation then explicit termination', observationFailure: true, disposition: 'transport-failed', terminal: false },
  { name: 'missing capture status after exit', outputFailure: true, reason: 'exited', disposition: 'transport-failed', retained: true },
  { name: 'cancelled parent', cancel: true, disposition: 'aborted' },
  { name: 'explicit termination', terminate: true, disposition: 'terminated' },
  { name: 'lost kill reply is not resent', killReplyLost: true, cancel: true, disposition: 'aborted' },
  { name: 'concurrent abort and shutdown', shutdown: true, disposition: 'aborted' },
  { name: 'cleanup failure visible', cleanupFailure: true, reason: 'exited', disposition: 'completed', retained: true },
  { name: 'unknown Core reason', reason: 'unknown', disposition: 'transport-failed' },
  { name: 'null Core reason', reason: null, disposition: 'transport-failed' },
  { name: 'Core hard kill reporting zero', reason: 'killed', disposition: 'transport-failed' },
]) it(`launches a trusted native job before Pi seeding: ${scenario.name}`, async () => {
  await coreFixture(async ({ dir, ctx, stateFile, requests }: any) => {
    process.env.HOME = dir;
    process.env.PI_TODO_PATH = '../explicit-tasks';
    const cache = join(dir, '.copilot/pkg', `${process.platform}-${process.arch}`, '1.0.106-3');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'package.json'), JSON.stringify({ version: '1.0.106-3' }));
    writeFileSync(join(cache, 'app.js'), '');
    const fullOutput = scenario.unicodeOutput ? '€'.repeat(33_334) : scenario.longOutput ? ('x'.repeat(1000) + '\n').repeat(400) : 'partial';
    const proof = join(dir, 'argv-proof.json');
    writeFileSync(join(dir, 'bin/copilot'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(proof)}, JSON.stringify({argv:process.argv.slice(2),autoUpdate:process.env.COPILOT_AUTO_UPDATE}));process.stdout.write(${JSON.stringify(fullOutput)});process.stderr.write('private diagnostic');process.exitCode=${scenario.code ?? 0};\n`, { mode: 0o700 });
    const agents = join(process.env.PI_CODING_AGENT_DIR!, 'agents'); mkdirSync(agents);
    writeFileSync(join(agents, 'native-worker.md'), '---\nname: native-worker\nrunner: copilot\nrunner-version: 1.0.106-3\nworkspace-trust: session\nnative-allow: []\nnative-deny: []\nmodel: gpt-6.1-sol\nauto-exit: true\ninteractive: false\n---\nTrusted role');
    const task = `Do work; $(touch '${join(dir, 'injection')}')`;
    const parsedBytes = readFileSync(join(agents, 'native-worker.md'), 'utf8');
    const launchCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile() {
      writeFileSync(join(agents, 'native-worker.md'), parsedBytes.replace('Trusted role', 'Changed after parsing'));
      return ctx.sessionManager.getSessionFile();
    } } };
    if (scenario.mux) {
      writeFileSync(join(dir, 'bin/herdr'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
      process.env.HERDR_SOCKET_PATH = join(dir, 'classic.sock');
      delete process.env.PI_SUBAGENT_MUX;
      if (scenario.mux === 'blank') process.env.PI_SUBAGENT_MUX = '  ';
      if (scenario.mux === 'herdr') process.env.PI_SUBAGENT_MUX = 'herdr';
      if (scenario.mux === 'missing-core') {
        delete process.env.HC_TERMINAL_SOCKET;
        delete process.env.HC_TERMINAL_ID;
      }
      if (scenario.mux === 'unknown-core') {
        for (const key of ['HERDR_SOCKET_PATH', 'CMUX_SOCKET_PATH', 'TMUX', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'WEZTERM_UNIX_SOCKET']) delete process.env[key];
        process.env.PI_SUBAGENT_MUX = 'unsupported-backend';
      }
      assert.equal(getMuxBackend(), scenario.expectedBackend ?? 'herdr');
    }
    const launch = () => __test__.launchSubagent({ name: 'Native', task, agent: 'native-worker', tools: ' ', skills: ' ', model: ' ', systemPrompt: ' ' }, launchCtx);
    if (scenario.rejected) {
      await assert.rejects(launch, scenario.rejected);
      assert.equal(requests.length, 0, 'rejected native jobs never launch through Core or fall back');
      assert.equal(readFileSync(join(dir, 'parent.jsonl'), 'utf8').trim().split('\n').length, 1, 'no Pi transcript seeding');
      assert.equal(existsSync(proof), false, 'no native executable invocation');
      assert.equal(getMuxBackend(), scenario.expectedBackend ?? 'herdr');
      return;
    }
    const running: any = await launch();
    if (scenario.mux) assert.equal(getMuxBackend(), 'herdr', 'native launch must not change the global backend');
    try {
      assert.equal(running.nativeJob.nativeReference.runner, 'copilot');
      assert.equal(running.nativeDefinition.sha256, createHash('sha256').update(parsedBytes).digest('hex'));
      assert.equal(running.nativeJob.context.env.PI_TODO_PATH, '../explicit-tasks');
      assert.equal(existsSync(running.sessionFile), false, 'no Pi transcript seeding');
      const script = readFileSync(running.launchScriptFile, 'utf8');
      assert.match(script, /COPILOT_AUTO_UPDATE=false/);
      assert.match(script, /--prefer-version/);
      assert.doesNotMatch(script, /PI_SUBAGENT_COMPLETION_FILE|--session /);
      assert.ok(running.nativeCapturePaths, 'native stdout has an owned current-job capture');
      try { execFileSync('/bin/bash', [running.launchScriptFile], { encoding: 'utf8', env: { ...process.env, COPILOT_AUTO_UPDATE: 'true' } }); }
      catch (error) { if (!scenario.code) throw error; }
      const child = JSON.parse(readFileSync(proof, 'utf8'));
      assert.equal(child.autoUpdate, 'false');
      assert.deepEqual(child.argv, running.nativeJob.argv.slice(3));
      assert.equal(child.argv.at(-1), `Trusted role\n\n${task}`);
      assert.equal(existsSync(join(dir, 'injection')), false);
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      writeFileSync(stateFile, JSON.stringify({ ...state,
        nativeExit: scenario.reason !== undefined || scenario.reason === null ? { exit_code: scenario.code ?? 0, signal: scenario.signal ?? null, reason: scenario.reason } : null,
        nativeTimeoutOnce: scenario.timeout === true, nativeTransientOnce: scenario.transient,
        nativeObservationFailure: scenario.observationFailure === true, nativeKillReplyLost: scenario.killReplyLost === true, rmFails: scenario.cleanupFailure === true,
      }));
      if (scenario.outputFailure) rmSync(running.nativeCapturePaths.status);
      __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
      const controller = new AbortController();
      running.abortController = controller;
      if (scenario.cancel) controller.abort('fixture parent cancelled');
      if (scenario.terminate) {
        const termination: any = await __test__.handleSubagentTerminate({ id: running.id });
        assert.equal(termination.details.status, 'terminated');
      }
      let reads = 0;
      const watched = __test__.watchSubagent(running, controller.signal, { visibleInterval: 1, nativeCaptureRead(paths: any, id: string) {
        if (reads++ < (scenario.readFailures ?? (scenario.readOnce ? 1 : 0))) throw Object.assign(new Error('fixture transient capture read'), { code: 'EIO' });
        return readNativeCapture(paths, id);
      } });
      if (scenario.shutdown) assert.deepEqual(await __test__.shutdownOwnedSubagents('fixture'), []);
      const result: any = await watched;
      assert.equal(result.runner, 'copilot');
      assert.equal(__test__.projectResultDetails(result, { name: 'Native', task }).capabilities.resume, 'managed-native-name');
      assert.equal(result.projection.taskOutcome, 'unknown');
      if (scenario.reason === 'exited') assert.equal(result.hostEvidence.terminal.pid, 456, 'finished Core records may retain their original PID');
      assert.equal(requests.filter((r: any) => r.method === 'terminal.read').length, 0, 'screen completeness is not capture authority');
      assert.equal(result.completion?.settled ?? false, false);
      assert.equal(result.projection.disposition, scenario.disposition);
      assert.equal(result.exitCode, scenario.disposition === 'completed' ? 0 : 1);
      if (scenario.timeout) assert.deepEqual(result.completion.requestTimeout, { operation: 'terminal.get', timeoutMs: 5000 });
      assert.equal(result.completion?.completionEvidence, scenario.disposition === 'completed' ? 'native-job-exit-output' : undefined);
      const captured = !scenario.observationFailure && !scenario.outputFailure;
      if (captured) assert.ok(Buffer.byteLength(result.summary) <= 65536);
      assert.equal(result.outputFile, running.nativeCapturePaths.stdout);
      assert.equal(readFileSync(result.outputFile, 'utf8'), fullOutput);
      assert.equal(result.projection.terminal, scenario.terminal !== false);
      assert.equal(__test__.runningSubagents.has(running.id), scenario.terminal === false || scenario.retained === true);
      assert.equal(result.nativeReference.selector.value, running.nativeJob.nativeReference.selector.value);
      assert.equal(statSync(result.outputFile).mode & 0o777, 0o600);
      if (captured) {
        assert.equal(result.outputCapture.source, 'current-job-stdout');
        const presentation = __test__.resolveResultPresentation(result, 'Native');
        assert.ok(presentation.includes(result.outputFile));
        assert.match(presentation, /private diagnostic/);
        if (scenario.longOutput || scenario.unicodeOutput) assert.match(presentation, /truncated/i);
        if (scenario.cleanupFailure) assert.match(presentation, /cleanup|fixture remove failure/i);
      }
      if (scenario.outputFailure) assert.notEqual(result.completion?.execution, 'normal-exit');
      if (scenario.observationFailure) {
        writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), nativeObservationFailure: false }));
        const terminated: any = await __test__.handleSubagentTerminate({ id: running.id });
        assert.equal(terminated.details.status, 'terminated');
        assert.equal(__test__.runningSubagents.has(running.id), false);
      }
      assert.equal(requests.filter((r: any) => r.method === 'terminal.run').length, 1);
      assert.equal(requests.filter((r: any) => r.method === 'terminal.kill').length, scenario.cancel || scenario.terminate || scenario.shutdown || scenario.observationFailure ? 1 : 0);
      assert.equal(requests.filter((r: any) => r.method === 'terminal.rm').length, scenario.outputFailure ? 0 : 1);
      if (scenario.cleanupFailure) {
        writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), rmFails: false }));
        assert.deepEqual(await __test__.shutdownOwnedSubagents('retry removal'), []);
        assert.equal(requests.filter((r: any) => r.method === 'terminal.kill').length, 0);
        assert.equal(requests.filter((r: any) => r.method === 'terminal.rm').length, 2);
      }
      const evidenceDir = process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(join(evidenceDir, scenario.name.replace(/[^a-z0-9]+/gi, '-') + '.json'), JSON.stringify({
          fixtureOnly: true, scenario: scenario.name, invokedExecutable: running.nativeJob.argv[2], child,
          launchRequest: requests.find((r: any) => r.method === 'terminal.run').params,
          coreCalls: Object.fromEntries(['terminal.run', 'terminal.kill', 'terminal.rm'].map(method => [method, requests.filter((r: any) => r.method === method).length])),
          hostEvidence: result.hostEvidence, projection: result.projection, capture: result.outputCapture,
          rawStdoutBytes: statSync(result.outputFile).size, rawStdoutMode: statSync(result.outputFile).mode & 0o777,
          registeredBeforeFixtureTeardown: __test__.runningSubagents.has(running.id),
        }, null, 2));
      }
    } finally { __test__.releaseRunningSubagent(running.id); }
  });
});

it("selects explicit Core without classic fallback and requires inherited identity", () => {
  const saved = { ...process.env };
  try {
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    delete process.env.HC_TERMINAL_SOCKET;
    delete process.env.HC_TERMINAL_ID;
    assert.equal(getMuxBackend(), null);
    process.env.HC_TERMINAL_SOCKET = "/fake/core.sock";
    process.env.HC_TERMINAL_ID = "t1";
    assert.equal(getMuxBackend(), "herdr-core");
    assert.match(muxSetupHint(), /Core/);
  } finally { process.env = saved; }
});

for (const capturedOverride of ['../captured task store', '']) it(`registered native tools persist caller-branch authority and resume captured data (override=${JSON.stringify(capturedOverride)})`, async () => {
  await coreFixture(async ({ dir, ctx, stateFile, requests }: any) => {
    const originalCwd = process.cwd();
    process.env.HOME = dir;
    process.env.PI_TODO_PATH = capturedOverride;
    const cache = join(dir, '.copilot/pkg', `${process.platform}-${process.arch}`, '1.0.106-3'); mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'package.json'), JSON.stringify({ version: '1.0.106-3' })); writeFileSync(join(cache, 'app.js'), '');
    const proof = join(dir, 'native-argv.json');
    writeFileSync(join(dir, 'bin/copilot'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(proof)}, JSON.stringify(process.argv.slice(2)));console.log('owned native output');\n`, { mode: 0o700 });
    const agents = join(process.env.PI_CODING_AGENT_DIR!, 'agents'); mkdirSync(agents);
    const codingPath = join(agents, 'native-worker.md');
    const policy = (name: string, readonly = false) => `---\nname: ${name}\nrunner: copilot\nrunner-version: 1.0.106-3\nworkspace-trust: session\nnative-allow: ${readonly ? '["tasks(todo)"]' : '[write, shell, "tasks(todo)"]'}\nnative-deny: ${readonly ? '[write, shell]' : '[]'}\nmodel: gpt-6.1-sol\n${readonly ? '' : 'skills: selected\n'}auto-exit: true\ninteractive: false\nmcp:\n  tasks:\n    command: "{node}"\n    args: ["{home}/.local/bin/pi-agent-tasks-mcp", "--scope-cwd", "{parentCwd}", "--store-override={env.PI_TODO_PATH}", "--actor", "{managedSessionId}", "--actions", "${readonly ? 'get,list,list-all' : 'get,claim,update,append,release'}"]\n    env:\n      HOME: "{home}"\n---\n${readonly ? 'READ ONLY ROLE' : 'CODING ROLE'}`;
    writeFileSync(codingPath, policy('native-worker'));
    writeFileSync(join(agents, 'native-reader.md'), policy('native-reader', true));
    const skillPath = join(process.env.PI_CODING_AGENT_DIR!, 'skills/selected/SKILL.md'); mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, 'ORIGINAL CANONICAL SKILL BYTES');
    const caller = SessionManager.create(dir, join(dir, 'caller-sessions'));
    const rootEntry = caller.appendCustomEntry('fixture-root', {});
    const callerCtx = { ...ctx, sessionManager: caller };
    const tools: any[] = [];
    const handlers = new Map<string, any>();
    const pi = { events: { emit() {} }, on(name: string, fn: any) { handlers.set(name, fn); }, registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
      sendMessage() {},
      appendEntry(type: string, data: unknown) { caller.appendCustomEntry(type, structuredClone(data)); },
      getCommands() { return [{ name: 'skill:selected', source: 'skill', sourceInfo: { path: skillPath, baseDir: dirname(skillPath), scope: 'user', origin: 'top-level', source: 'auto' } }]; },
    };
    subagentsExtension(pi as any);
    const launch = tools.find(t => t.name === 'subagent');
    let resume = tools.find(t => t.name === 'subagent_resume');
    const call = (tool: any, params: any, context = callerCtx) => tool.execute('fixture', params, undefined, undefined, context);
    const records = () => caller.getBranch().filter((e: any) => e.type === 'custom' && e.customType === 'pi-interactive-subagents.native-session');
    const complete = async () => {
      const running: any = [...__test__.runningSubagents.values()][0];
      assert.ok(running);
      execFileSync('/bin/bash', [running.launchScriptFile], { env: { ...process.env, HOME: '/contradictory-child-home' } });
      writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), nativeExit: { exit_code: 0, signal: null, reason: 'exited' } }));
      const deadline = Date.now() + 4000;
      while (__test__.runningSubagents.has(running.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(__test__.runningSubagents.has(running.id), false);
      assert.equal((records().at(-1) as any).data.state, 'closed');
      return { running, argv: JSON.parse(readFileSync(proof, 'utf8')) };
    };
    try {
      const first = await call(launch, { name: 'Native', task: 'First task', agent: 'native-worker' });
      const managedSessionId = first.details.nativeReference.managedSessionId;
      assert.equal(first.details.capabilities.resume, 'managed-native-name');
      await assert.rejects(() => call(resume, { managedSessionId, message: 'Concurrent' }), /active|unconfirmed/i);
      const one = await complete();
      const closedLeaf = caller.getLeafId()!;
      const firstRecord = structuredClone((records().at(-1) as any).data);
      caller.branch(rootEntry);
      await assert.rejects(() => call(resume, { managedSessionId, message: 'Abandoned branch' }), /unknown.*managed/i);
      caller.branch(closedLeaf);
      // A replacement extension runtime must restore the current caller branch,
      // not rely on the original factory's record map.
      tools.length = 0;
      subagentsExtension(pi as any);
      handlers.get('session_start')({}, callerCtx);
      resume = tools.find(t => t.name === 'subagent_resume');
      const foreign = { ...callerCtx, sessionManager: { getBranch: () => caller.getBranch(), getSessionId: () => 'another-caller' } };
      await assert.rejects(() => call(resume, { managedSessionId, message: 'Foreign' }, foreign as any), /unknown.*managed/i);
      await assert.rejects(() => call(resume, { managedSessionId, message: ' ', autoExit: true }), /follow.up message/i);
      await assert.rejects(() => call(resume, { managedSessionId, message: 'No', autoExit: false }), /autoExit/);
      writeFileSync(skillPath, 'MUTATED SKILL MUST NOT REPLACE SNAPSHOT');
      // A worker-controlled sidecar is not an authority source.
      writeFileSync(join(dir, 'forged-native-snapshot.json'), JSON.stringify({ managedSessionId, command: '/forged', allow: ['*'] }));
      delete process.env.PI_TODO_PATH;
      const changedCwd = join(dir, 'other-parent-cwd'); mkdirSync(changedCwd);
      process.chdir(changedCwd);
      writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), nativeExit: null }));
      const next = await call(resume, { managedSessionId, message: 'Follow-up', agent: ' ', sessionPath: ' ' }, { ...callerCtx, cwd: changedCwd });
      assert.equal(next.details.nativeReference.selector.value, first.details.nativeReference.selector.value);
      const two = await complete();
      assert.notEqual(two.running.runId, one.running.runId);
      assert.ok(two.argv.includes('--resume'));
      assert.ok(!two.argv.includes('--name'));
      assert.ok(!two.argv.includes('--trust-folder'));
      assert.match(two.argv.at(-1), /ORIGINAL CANONICAL SKILL BYTES/);
      assert.doesNotMatch(two.argv.at(-1), /MUTATED/);
      const mcp = JSON.parse(two.argv[two.argv.indexOf('--additional-mcp-config') + 1]).mcpServers.tasks;
      assert.deepEqual(mcp.env, { HOME: dir });
      assert.equal(mcp.command, process.execPath);
      assert.ok(mcp.args.includes(`--store-override=${capturedOverride}`));
      assert.equal(mcp.args.filter((arg: string) => arg.startsWith('--store-override=')).length, 1);
      assert.equal(mcp.args[mcp.args.indexOf('--scope-cwd') + 1], dir);
      assert.equal(mcp.args[mcp.args.indexOf('--actor') + 1], managedSessionId);
      const before = requests.length;
      writeFileSync(codingPath, policy('native-worker') + '\nChanged definition');
      await assert.rejects(() => call(resume, { managedSessionId, message: 'Changed defaults' }), /definition changed/i);
      assert.equal(requests.length, before);
      writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), nativeExit: null }));
      await call(resume, { managedSessionId, agent: 'native-reader', message: 'Read only follow-up' });
      const three = await complete();
      assert.ok(three.argv.includes('--deny-tool=write')); assert.ok(three.argv.includes('--deny-tool=shell'));
      assert.ok(!three.argv.includes('--allow-tool=write'));
      assert.match(three.argv.at(-1), /READ ONLY ROLE/); assert.doesNotMatch(three.argv.at(-1), /CODING ROLE|ORIGINAL CANONICAL/);
      const restricted = JSON.parse(three.argv[three.argv.indexOf('--additional-mcp-config') + 1]).mcpServers.tasks;
      assert.equal(restricted.args.at(-1), 'get,list,list-all');
      assert.deepEqual((records()[1] as any).data, firstRecord, 'original closed snapshot is immutable');
      assert.equal(requests.filter((r: any) => r.method === 'terminal.run').length, 3);
      assert.equal(requests.filter((r: any) => r.method === 'terminal.rm').length, 3);
      assert.equal(requests.filter((r: any) => r.method === 'terminal.kill').length, 0);
      const beforeRejectedProfiles = requests.length;
      const validLeaf = caller.getLeafId()!;
      const lastRecord = structuredClone((records().at(-1) as any).data);
      delete lastRecord.record.definitionOrigin;
      caller.appendCustomEntry('pi-interactive-subagents.native-session', lastRecord);
      await assert.rejects(() => call(resume, { managedSessionId, agent: 'native-reader', message: 'Missing origin' }), /invalid caller native session/i);
      caller.branch(validLeaf);
      rmSync(join(agents, 'native-reader.md'));
      await assert.rejects(() => call(resume, { managedSessionId, message: 'Missing definition' }), /missing trusted native/i);
      writeFileSync(join(agents, 'native-reader.md'), policy('native-reader', true));
      const projectAgents = join(dir, '.pi/agents'); mkdirSync(projectAgents, { recursive: true });
      writeFileSync(join(projectAgents, 'native-reader.md'), '---\nname: native-reader\n---\nProject shadow');
      for (const agent of [undefined, 'native-reader']) await assert.rejects(() => call(resume, { managedSessionId, agent, message: 'Shadow must reject' }), /shadow/i);
      writeFileSync(join(projectAgents, 'project-native.md'), policy('project-native', true));
      await assert.rejects(() => call(resume, { managedSessionId, agent: 'project-native', message: 'Project policy must reject' }), /origin|trusted|project/i);
      assert.equal(requests.length, beforeRejectedProfiles);
      if (process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR) {
        mkdirSync(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, { recursive: true });
        writeFileSync(join(process.env.PI_TEST_NATIVE_FIXTURE_EVIDENCE_DIR, capturedOverride ? 'managed-relative.json' : 'managed-empty.json'), JSON.stringify({ fixtureOnly: true, capturedOverride, managedSessionId, nativeName: first.details.nativeReference.selector.value,
          runs: [one, two, three].map(({ running, argv }) => ({ runId: running.runId, argv, cwd: running.nativeJob.cwd, context: running.nativeJob.context })),
          coreCalls: Object.fromEntries(['terminal.run', 'terminal.kill', 'terminal.rm'].map(method => [method, requests.filter((r: any) => r.method === method).length])),
          callerEntries: records(), ownedResourcesRemaining: __test__.runningSubagents.size,
        }, null, 2));
      }
    } finally {
      process.chdir(originalCwd);
      await handlers.get('session_shutdown')({ reason: 'fixture' }, callerCtx);
    }
  });
});

it('registered native resume accepts only one caller-owned reference and rejects paths/profiles before Core effects', async () => {
  await coreFixture(async ({ ctx, requests }: any) => {
    const tools: any[] = [];
    subagentsExtension({ events: { emit() {} }, on() {}, registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} } as any);
    const tool = tools.find(tool => tool.name === 'subagent_resume');
    const caller = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [] } };
    for (const params of [{}, { managedSessionId: 'unknown', sessionPath: '/also' }, { managedSessionId: 'unknown', command: 'forged' }, { managedSessionId: 'unknown', snapshotPath: '/forged' }, { managedSessionId: 'unknown', selector: 'history' }, { managedSessionId: 'unknown', grants: ['*'] }, { sessionPath: '/pi', agent: 'native' }]) {
      await assert.rejects(() => tool.execute('invalid', params, undefined, undefined, caller), /exactly one|unknown.*field|native.only|agent.*native/i);
    }
    await assert.rejects(() => tool.execute('unknown', { managedSessionId: 'unknown', sessionPath: ' ', agent: ' ' }, undefined, undefined, caller), /unknown.*managed/i);
    assert.equal(requests.length, 0);
  });
});

it('registered native launch rejects a hidden project-package skill shadow before any Core RPC', async () => {
  await coreFixture(async ({ dir, ctx, requests }: any) => {
    process.env.HOME = dir;
    const agents = join(process.env.PI_CODING_AGENT_DIR!, 'agents'); mkdirSync(agents);
    writeFileSync(join(agents, 'native-worker.md'), '---\nname: native-worker\nrunner: copilot\nrunner-version: 1.0.106-3\nworkspace-trust: session\nnative-allow: []\nnative-deny: []\nmodel: gpt-6.1-sol\nskills: collision\nauto-exit: true\ninteractive: false\n---\nTrusted role');
    const globalSkill = join(process.env.PI_CODING_AGENT_DIR!, 'skills/collision/SKILL.md');
    mkdirSync(dirname(globalSkill), { recursive: true });
    writeFileSync(globalSkill, '---\nname: collision\ndescription: Fixture skill\n---\nTRUSTED BODY');
    const pkg = join(dir, '.pi/npm/node_modules/shadow-package'); mkdirSync(join(pkg, 'skills/collision'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'shadow-package', version: '1.0.0', pi: { skills: ['./skills'] } }));
    writeFileSync(join(pkg, 'skills/collision/SKILL.md'), '---\nname: collision\ndescription: Project skill\n---\nPROJECT BODY');
    writeFileSync(join(dir, '.pi/settings.json'), JSON.stringify({ packages: ['npm:shadow-package'] }));
    const tools: any[] = [];
    subagentsExtension({ events: { emit() {} }, on() {}, registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
      getCommands() { return [{ name: 'skill:collision', source: 'skill', sourceInfo: { path: globalSkill, baseDir: dirname(globalSkill), scope: 'user', origin: 'top-level', source: 'auto' } }]; },
    } as any);
    await assert.rejects(() => tools.find(tool => tool.name === 'subagent').execute('shadow', { name: 'Native', task: 'Work', agent: 'native-worker' }, undefined, undefined, ctx), /project skill shadow/i);
    assert.equal(requests.length, 0);
  });
});

it('native record corruption is isolated from registered session startup and Pi delivery', async () => {
  await coreFixture(async ({ ctx }: any) => {
    const handlers = new Map<string, any>(); const tools: any[] = []; const messages: any[] = [];
    const entries = [{ type: 'custom', customType: 'pi-interactive-subagents.native-session', data: { version: 2 } }];
    const caller = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => entries } };
    subagentsExtension({ events: { emit() {} }, on(n: string, f: any) { handlers.set(n, f); }, registerTool(t: any) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage(m: any) { messages.push(m); } } as any);
    try {
      assert.doesNotThrow(() => handlers.get('session_start')({}, caller));
      await assert.rejects(() => tools.find(t => t.name === 'subagent_resume').execute('bad', { managedSessionId: 'unknown', message: 'Never run' }, undefined, undefined, caller), /invalid caller native/i);
      // Startup must activate the shared delivery channel despite native corruption.
      const run = await tools.find(t => t.name === 'subagent').execute('pi', { name: 'Pi control', task: 'Fixture' }, undefined, undefined, caller);
      assert.equal(run.details.status, 'started');
      const running: any = __test__.runningSubagents.get(run.details.id);
      running.abortController.abort('fixture');
      const until = Date.now() + 2000;
      while (!messages.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(messages.some(m => m.customType === 'subagent_result'), 'Pi result delivery remains active');
    } finally { await handlers.get('session_shutdown')({ reason: 'fixture' }, caller); }
  });
});

it('fresh native lookup rejects caller cwd shadow when process cwd differs', async () => {
  await coreFixture(async f => {
    const agents = join(process.env.PI_CODING_AGENT_DIR!, 'agents'); mkdirSync(agents);
    writeFileSync(join(agents, 'native-worker.md'), nativeBoundaryDefinition);
    const shadow = join(f.dir, '.pi/agents'); mkdirSync(shadow, { recursive: true });
    writeFileSync(join(shadow, 'native-worker.md'), '---\nname: native-worker\n---\nProject Pi shadow');
    await assert.rejects(() => __test__.launchSubagent({ name: 'Native', task: 'Never run', agent: 'native-worker' }, f.ctx), /shadow/i);
    assert.equal(f.requests.length, 0);
  });
});

const nativeBoundaryDefinition = '---\nname: native-worker\nrunner: copilot\nrunner-version: 1.0.106-3\nworkspace-trust: session\nnative-allow: []\nnative-deny: []\nmodel: gpt-6.1-sol\nauto-exit: true\ninteractive: false\n---\nTrusted boundary fixture';
async function nativeBoundaryFixture(fn: (f: any) => Promise<void>) {
  await coreFixture(async f => {
    process.env.HOME = f.dir;
    const cache = join(f.dir, '.copilot/pkg', `${process.platform}-${process.arch}`, '1.0.106-3'); mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'package.json'), JSON.stringify({ version: '1.0.106-3' })); writeFileSync(join(cache, 'app.js'), '');
    writeFileSync(join(f.dir, 'bin/copilot'), `#!${process.execPath}\nconsole.log('owned boundary output');`, { mode: 0o700 });
    const agents = join(process.env.PI_CODING_AGENT_DIR!, 'agents'); mkdirSync(agents);
    const definitionPath = join(agents, 'native-worker.md'); writeFileSync(definitionPath, nativeBoundaryDefinition);
    const manager = SessionManager.create(f.dir, join(f.dir, 'boundary-sessions')); manager.appendCustomEntry('fixture', {});
    const captured = { version: 1, agent: 'native-worker', runId: 'original-closed-run', state: 'closed', record: {
      callerSessionId: manager.getSessionId(), reference: { runner: 'copilot', managedSessionId: 'boundary-managed', cwd: f.dir, selector: { kind: 'name', value: 'boundary-native-name' } },
      definitionOrigin: { kind: 'global-user', canonicalPath: definitionPath, canonicalRoot: agents }, definitionSha256: createHash('sha256').update(nativeBoundaryDefinition).digest('hex'),
      bindings: { parentCwd: f.dir, managedSessionId: 'boundary-managed', todoPathLiteral: '' }, skills: [],
    } };
    manager.appendCustomEntry('pi-interactive-subagents.native-session', structuredClone(captured));
    const ctx = { ...f.ctx, sessionManager: manager }; let failClosedAppend = false;
    const bind = () => {
      const tools: any[] = []; const handlers = new Map<string, any>();
      subagentsExtension({ events: { emit() {} }, on(n: string, h: any) { handlers.set(n, h); }, registerTool(t: any) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getCommands() { return []; },
        appendEntry(type: string, data: any) { if (failClosedAppend && data.state === 'closed') throw new Error('fixture closed append failure'); manager.appendCustomEntry(type, structuredClone(data)); },
      } as any);
      handlers.get('session_start')({}, ctx);
      return { handlers,
        launch: () => tools.find(t => t.name === 'subagent').execute('fresh', { name: 'Fresh', task: 'Never run', agent: 'native-worker' }, undefined, undefined, ctx),
        resume: (managedSessionId = 'boundary-managed') => tools.find(t => t.name === 'subagent_resume').execute('resume', { managedSessionId, message: 'Boundary follow-up' }, undefined, undefined, ctx),
      };
    };
    let bound = bind();
    const entries = () => manager.getBranch().filter((e: any) => e.type === 'custom' && e.customType === 'pi-interactive-subagents.native-session');
    const state = (delta: any) => writeFileSync(f.stateFile, JSON.stringify({ ...JSON.parse(readFileSync(f.stateFile, 'utf8')), ...delta }));
    const complete = async () => {
      const running: any = [...__test__.runningSubagents.values()][0];
      execFileSync('/bin/bash', [running.launchScriptFile], { env: process.env });
      running.nativePollInterval = 1; state({ nativeExit: { exit_code: 0, signal: null, reason: 'exited' } });
      const until = Date.now() + 1500;
      while (__test__.runningSubagents.has(running.id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      return running;
    };
    try { await fn({ ...f, ctx, manager, captured, entries, state, complete, launch: () => bound.launch(), resume: (id?: string) => bound.resume(id), rebind() { bound = bind(); }, failAppend() { failClosedAppend = true; } }); }
    finally { failClosedAppend = false; if (manager.getBranch().at(-1)?.type === 'custom' && (manager.getBranch().at(-1) as any).data?.version === 2) manager.branch(manager.getBranch().at(-2)!.id); await bound.handlers.get('session_shutdown')({ reason: 'fixture' }, ctx); }
  });
}
for (const failure of ['hello', 'local-file', 'refused', 'ambiguous']) it(`native resume preserves definite versus uncertain launch authority: ${failure}`, async () => nativeBoundaryFixture(async f => {
  const socket = process.env.HC_TERMINAL_SOCKET;
  const blocker = join(f.manager.getSessionDir(), 'artifacts', f.manager.getSessionId(), 'subagent-scripts');
  if (failure === 'hello') process.env.HC_TERMINAL_SOCKET = join(f.dir, 'missing.sock');
  else if (failure === 'local-file') { mkdirSync(dirname(blocker), { recursive: true }); writeFileSync(blocker, 'owned fixture blocks script directory'); }
  else f.state(failure === 'refused' ? { refuseRun: true, hideChild: true } : { unconfirmed: true, hideChild: true });
  await assert.rejects(f.resume);
  process.env.HC_TERMINAL_SOCKET = socket;
  if (failure === 'ambiguous') {
    assert.equal(f.entries().at(-1).data.state, 'open'); f.rebind();
    const calls = f.requests.length; await assert.rejects(f.resume, /active|unconfirmed/i); assert.equal(f.requests.length, calls);
  } else {
    assert.deepEqual(f.entries().at(-1).data, f.captured, 'restore original closure, never fabricate closure for failed new run');
    assert.equal(f.requests.filter((r: any) => r.method === 'terminal.run').length, failure === 'refused' ? 1 : 0);
    if (failure === 'local-file') rmSync(blocker);
    f.state({ refuseRun: false, hideChild: false }); f.rebind(); await f.resume();
    const running = await f.complete(); assert.equal(__test__.runningSubagents.has(running.id), false);
  }
}));
it('fresh failed native preparation grants no closed resume authority', async () => nativeBoundaryFixture(async f => {
  process.env.HC_TERMINAL_SOCKET = join(f.dir, 'missing-fresh.sock');
  await assert.rejects(f.launch);
  const fresh = f.entries().at(-1).data;
  assert.notEqual(fresh.record.reference.managedSessionId, 'boundary-managed');
  assert.equal(fresh.state, 'open');
  await assert.rejects(() => f.resume(fresh.record.reference.managedSessionId), /active|unconfirmed/i);
  assert.equal(f.requests.length, 0);
}));

for (const failure of ['malformed-branch', 'append-failure']) it(`proven native closure releases resources despite ${failure}`, async () => nativeBoundaryFixture(async f => {
  await f.resume();
  if (failure === 'malformed-branch') f.manager.appendCustomEntry('pi-interactive-subagents.native-session', { version: 2 });
  else f.failAppend();
  const running = await f.complete();
  assert.equal(__test__.runningSubagents.has(running.id), false, 'closed Core/native resources must release independently of persistence');
  assert.equal(f.entries().some((e: any) => e.data.runId === running.runId && e.data.state === 'closed'), false);
  assert.match(running.nativeDiagnostic, /persist|record|append/i);
  await assert.rejects(f.resume, /invalid caller|active|unconfirmed/i);
}));

async function coreFixture(run: (fixture: any) => Promise<void>) {
  const saved = { ...process.env };
  const originalArgv = process.argv[1];
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cl-")));
  const requests: any[] = [];
  const stateFile = join(dir, "app.json");
  const appLog = join(dir, "app.log");
  const parent = { address: "t1", state: "live", pid: 123, argv: ["/bin/zsh"], parent: null,
    labels: { "herdr.space": "space-test", "herdr.tab": "parent-tab" } };
  let child: any;
  const server = createServer(socket => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer);
      requests.push(request);
      let result: any;
      switch (request.method) {
        case "hello": result = { generation: 1, core: { id: "test-core" }, methods: ["terminal.run", "terminal.get", "terminal.list", "terminal.read", "terminal.keys", "terminal.kill", "terminal.rm"] }; break;
        case "terminal.get":
          if (request.params.terminal !== "t1" && JSON.parse(readFileSync(stateFile, "utf8")).missingChild) {
            socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture missing registry record", data: { kind: "not_found" } } }) + "\n"); return;
          }
          if (request.params.terminal !== "t1") {
            const state = JSON.parse(readFileSync(stateFile, "utf8"));
            if (state.nativeObservationFailure) {
              socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture observation lost', data: { kind: 'not_found' } } }) + '\n');
              return;
            }
            if (state.nativeTransientOnce) {
              writeFileSync(stateFile, JSON.stringify({ ...state, nativeTransientOnce: undefined }));
              socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture transient observation', data: { kind: state.nativeTransientOnce } } }) + '\n');
              return;
            }
            if (state.nativeTimeoutOnce) {
              writeFileSync(stateFile, JSON.stringify({ ...state, nativeTimeoutOnce: false }));
              socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture observation timeout', data: { kind: 'timeout' } } }) + '\n');
              return;
            }
            if (state.nativeExit) child = { ...child, state: "finished", ...state.nativeExit };
          }
          result = request.params.terminal === "t1" ? parent : child; break;
        case "terminal.run":
          if (JSON.parse(readFileSync(stateFile, 'utf8')).refuseRun) {
            socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture definite run refusal', data: { kind: 'invalid_params' } } }) + '\n'); return;
          }
          child = { address: "t2", state: "live", pid: 456, argv: request.params.argv, parent: "t1", labels: request.params.labels };
          const serviceState = JSON.parse(readFileSync(stateFile, "utf8"));
          const childEnv = { HERDR_APP_HOME: serviceState.coreServerHome, ...request.params.env };
          writeFileSync(stateFile, JSON.stringify({ ...serviceState, child: true, childTab: request.params.labels["herdr.tab"], childSpace: request.params.labels["herdr.space"], childHome: childEnv.HERDR_APP_HOME }));
          if (JSON.parse(readFileSync(stateFile, "utf8")).unconfirmed) {
            const reply = () => socket.end(JSON.stringify({ jsonrpc: "2.0", id: "uncorrelated", result: child }) + "\n");
            if (JSON.parse(readFileSync(stateFile, "utf8")).delayRunReply) setTimeout(reply, 50); else reply();
            return;
          }
          result = child; break;
        case "terminal.list": {
          const state = JSON.parse(readFileSync(stateFile, "utf8"));
          result = { terminals: state.hideChild || state.hideChildOnce ? [] : state.ambiguous ? [child, { ...child, address: "t3" }] : [child], hidden_finished: 0 };
          if (state.hideChildOnce) writeFileSync(stateFile, JSON.stringify({ ...state, hideChildOnce: false }));
          break;
        }
        case "terminal.kill":
          if (JSON.parse(readFileSync(stateFile, 'utf8')).nativeKillReplyLost) {
            child = { ...child, state: 'finished', exit_code: 143, signal: null, reason: 'killed' };
            socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture lost kill reply', data: { kind: 'transport' } } }) + '\n');
            return;
          }
          if (JSON.parse(readFileSync(stateFile, "utf8")).killFails) {
            socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture kill failure", data: { kind: "busy" } } }) + "\n"); return;
          }
          child = { ...child, state: "finished", pid: null, exit_code: 143 }; result = child; break;
        case "terminal.rm":
          if (JSON.parse(readFileSync(stateFile, "utf8")).rmFails) {
            socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture remove failure", data: { kind: "busy" } } }) + "\n"); return;
          }
          result = { removed: "t2" }; break;
        case "terminal.keys": result = { turn: 1 }; break;
        case "terminal.read":
          if (JSON.parse(readFileSync(stateFile, 'utf8')).nativeOutputFailure) {
            socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'fixture missing output', data: { kind: 'not_found' } } }) + '\n');
            return;
          }
          result = { text: JSON.parse(readFileSync(stateFile, 'utf8')).nativeOutputUnicode ? '€'.repeat(33_334) : JSON.parse(readFileSync(stateFile, 'utf8')).nativeOutputLarge ? 'x'.repeat(100_000) : 'partial', complete: true }; break;
        default: throw new Error(`unexpected RPC ${request.method}`);
      }
      socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    });
  });
  try {
    __test__.ensureModuleAbortController();
    const bin = join(dir, "bin"); mkdirSync(bin);
    const packageDir = join(dir, "pi-package"); mkdirSync(packageDir);
    const entry = join(packageDir, "cli.js"); writeFileSync(entry, "// fake Pi entrypoint\n");
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "fixture", bin: { pi: "cli.js" } }));
    process.argv[1] = entry;
    writeFileSync(stateFile, JSON.stringify({ child: false }));
    writeFileSync(join(bin, "herdr-app"), `#!${process.execPath}\nconst fs=require('node:fs');const file=${JSON.stringify(stateFile)};const log=${JSON.stringify(appLog)};const args=process.argv.slice(2);fs.appendFileSync(log,JSON.stringify({args,home:process.env.HERDR_APP_HOME})+'\\n');const state=JSON.parse(fs.readFileSync(file));const visibleChild=state.child&&state.childSpace&&!(state.adoptPending>0);if(state.child&&state.adoptPending>0&&args[0]==='ls'){state.adoptPending--;fs.writeFileSync(file,JSON.stringify(state));}let result;if(args[0]==='ls')result={spaces:[{id:'space-test',machine:null,tabs:[{id:'parent-tab',name:'parent',terminals:[{terminal:state.badParent?'t9':'t1',pane:'parent-pane'},...(visibleChild&&state.childTab==='parent-tab'?[{terminal:'t2',pane:state.adoptionFails?null:'child-pane'}]:[])]},...(visibleChild&&state.childTab!=='parent-tab'?[{id:'child-tab',name:'child',terminals:[{terminal:'t2',pane:'child-pane'}]}]:[])]}]};else if(args[0]==='status')result={space:'space-test',tab:'parent-tab'};else throw Error('forbidden app command');console.log(JSON.stringify(result));\n`, { mode: 0o700 });
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.HERDR_APP_HOME = join(dir, "selected-app");
    process.env.PI_CODING_AGENT_DIR = join(dir, "profile"); mkdirSync(process.env.PI_CODING_AGENT_DIR);
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    process.env.HC_TERMINAL_ID = "t1";
    process.env.HC_TERMINAL_SOCKET = join(dir, "api.sock");
    const session = join(dir, "parent.jsonl"); writeFileSync(session, JSON.stringify({ type: "session", id: "parent", cwd: dir }) + "\n");
    server.listen(process.env.HC_TERMINAL_SOCKET); await once(server, "listening");
    await run({ dir, entry, requests, parent, appLog, stateFile, ctx: { cwd: dir, sessionManager: { getSessionFile: () => session, getSessionId: () => "parent", getSessionDir: () => dir } } });
  } finally {
    process.env = saved; process.argv[1] = originalArgv;
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const autoExit of [true, false]) {
  it(`resumes through the registered tool with autoExit=${autoExit} and captured Core ownership`, async () => {
    await coreFixture(async ({ dir, ctx, requests, entry, appLog }: any) => {
      const sessionPath = join(dir, "resume.jsonl");
      writeFileSync(sessionPath, [
        { type: "session", id: "old-session", cwd: dir },
        { type: "custom", customType: "pi-interactive-subagents.resume-policy", data: {
          version: 2, sessionId: "old-session", agent: null, deniedTools: ["bash"], cwd: dir,
          agentDir: process.env.PI_CODING_AGENT_DIR, systemPrompt: null, requestedSkills: [], activeTools: ["read"], skills: [],
        } },
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
      const tools: any[] = [];
      const handlers = new Map<string, any>();
      subagentsExtension({
        events: { emit() {}, on() { return () => {}; } }, on(name: string, handler: any) { handlers.set(name, handler); },
        registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
        sendMessage() {}, getAllTools() { return []; },
      } as any);
      try {
        const result = await tools.find(tool => tool.name === "subagent_resume").execute("test", { sessionPath, name: "Resume task", message: "Continue once", autoExit }, undefined, undefined, ctx);
        assert.equal(result.details.status, "started");
        const launch = requests.find((request: any) => request.method === "terminal.run").params;
        assert.equal(launch.labels["herdr.space"], autoExit ? undefined : "space-test");
        assert.equal(launch.labels["herdr.tab"], autoExit ? undefined : "parent-tab");
        assert.equal(existsSync(appLog), !autoExit);
        const script = readFileSync(launch.argv[1], "utf8");
        assert.ok(script.includes(entry));
        assert.match(script, /PI_SUBAGENT_RESTORE_POLICY=1/);
        assert.match(script, /PI_DENY_TOOLS='bash'/);
        assert.match(script, /--tools 'read'/);
        assert.match(script, /PI_SUBAGENT_SURFACE="\$HC_TERMINAL_ID"/);
        const running = [...__test__.runningSubagents.values()][0];
        assert.equal(running.coreHost.address, "t2");
        // A stale/new global selector must not reroute controls away from the captured Core.
        process.env.PI_SUBAGENT_MUX = "zellij";
        const interrupted = await tools.find(tool => tool.name === "subagent_interrupt").execute("escape", { id: running.id }, undefined, undefined, ctx);
        assert.equal(interrupted.details.status, "interrupt_requested");
        assert.equal(requests.filter((request: any) => request.method === "terminal.keys").length, 1);
      } finally {
        await handlers.get("session_shutdown")({ reason: "quit" }, ctx);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
  });
}

for (const scenario of [
  { name: "default autonomous", agent: "autonomous", expected: false },
  { name: "explicit true overrides auto-exit", agent: "autonomous", interactive: true, expected: true },
  { name: "explicit false with auto-exit", agent: "autonomous", interactive: false, expected: false },
  { name: "explicit false overrides interactive definition", agent: "interactive", interactive: false, expected: false },
  { name: "explicit false on bare launch", interactive: false, expected: false },
  { name: "nested row without app labels", agent: "autonomous", nested: true, expected: false },
]) {
  it(`presents ${scenario.name} using resolved interactivity`, async () => {
    await coreFixture(async ({ ctx, requests, parent, appLog }: any) => {
      const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents");
      mkdirSync(agents);
      writeFileSync(join(agents, "autonomous.md"), "---\nname: autonomous\nauto-exit: true\n---\nInspect once.\n");
      writeFileSync(join(agents, "interactive.md"), "---\nname: interactive\ninteractive: true\nauto-exit: false\n---\nInspect interactively.\n");
      if (scenario.nested) parent.labels = {};
      const runtime = registeredRuntime(ctx);
      try {
        const result = await runtime.launch({ name: scenario.name, task: "inspect", agent: scenario.agent, interactive: scenario.interactive });
        assert.equal(result.details.status, "started");
        const launch = requests.find((request: any) => request.method === "terminal.run").params;
        assert.equal(launch.parent, "t1");
        assert.equal(launch.caller, "t1");
        assert.match(launch.name, /^[a-z0-9_-]{1,32}$/);
        assert.equal(launch.name, `${scenario.name.replaceAll(" ", "-").slice(0, 23)}-${launch.labels["pi.subagent.run"]}`);
        assert.equal(launch.labels["herdr.space"], scenario.expected ? "space-test" : undefined);
        assert.equal(launch.labels["herdr.tab"], scenario.expected ? "parent-tab" : undefined);
        assert.ok(launch.labels["pi.subagent.run"]);
        assert.equal(launch.env.HERDR_APP_HOME, process.env.HERDR_APP_HOME);
        assert.equal(existsSync(appLog), scenario.expected, "rows never call the app");
        if (scenario.expected) {
          const calls = readFileSync(appLog, "utf8").trim().split("\n").map(line => JSON.parse(line).args);
          assert.ok(calls.every(args => ["ls", "status"].includes(args[0])));
        }
      } finally {
        await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      }
    });
  });
}

it("keeps Core names unique by run for repeated, long and non-ASCII titles", async () => {
  await coreFixture(async ({ dir, requests }: any) => {
    for (const [index, title] of ["Review task", "Review task ".repeat(12), "調査🧪".repeat(30)].entries()) {
      const prepared = await prepareCoreLaunch(title, false);
      const runIds = [`a000000${index}`, `b000000${index}`];
      for (const runId of runIds) {
        await launchPreparedCoreRun(prepared, {
          runId, scriptPath: join(dir, `${runId}.sh`), wrapperStartFile: join(dir, `${runId}.json`),
          command: "true", cwd: dir, agentDir: process.env.PI_CODING_AGENT_DIR!,
        });
      }
      const launches = requests.filter((request: any) => request.method === "terminal.run").slice(-2);
      const names = launches.map((request: any) => request.params.name);
      assert.notEqual(names[0], names[1], "same task title must not collide across runs");
      for (const [runIndex, name] of names.entries()) {
        assert.match(name, /^[a-z0-9_-]{1,32}$/);
        assert.ok(name.endsWith(`-${runIds[runIndex]}`), "preserve the complete run suffix");
        assert.ok(name.startsWith(index === 2 ? "pi-subagent-" : "review-task-"));
      }
    }
  });
});

it("launches Pi through Core once with a prepared wrapper and same-tab right pane", async () => {
  await coreFixture(async ({ ctx, requests, entry, appLog }: any) => {
    const running = await __test__.launchSubagent({ name: "Review\u001b[31m task", task: "Inspect exactly once", tools: "read", interactive: true }, ctx);
    const launches = requests.filter((request: any) => request.method === "terminal.run");
    assert.equal(launches.length, 1);
    const launch = launches[0].params;
    assert.equal(running.coreHost.address, "t2");
    assert.deepEqual(running.coreHost.runtime, { node: process.execPath, script: entry, version: "fixture" });
    assert.equal(running.surface, "t2");
    assert.deepEqual(launch.labels, { "herdr.space": "space-test", "herdr.tab": "parent-tab", "pi.subagent.run": running.runId });
    assert.equal(launch.env.PI_SUBAGENT_MUX, "herdr-core");
    assert.equal(launch.env.HERDR_SOCKET_PATH, "");
    assert.equal(launch.env.PI_SUBAGENT_ID, "");
    assert.equal(launch.env.HC_TERMINAL_ID, undefined);
    assert.equal(launch.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR);
    const script = readFileSync(launch.argv[1], "utf8");
    assert.ok(script.includes(entry));
    assert.ok(script.includes(process.execPath));
    assert.match(script, /PI_SUBAGENT_SURFACE="\$HC_TERMINAL_ID"/);
    assert.ok(script.includes(running.wrapperExitFile));
    assert.ok(script.includes(running.coreHost.wrapperStartFile));
    assert.equal((script.match(/Inspect exactly once/g) ?? []).length, 0, "blank-session task must be artifact-backed");
    const appCalls = readFileSync(appLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(appCalls.every(call => call.home === process.env.HERDR_APP_HOME));
    assert.ok(appCalls.every(call => ["ls", "status"].includes(call.args[0])), "no rename, split or focus commands");
    assert.equal(launch.name, `review-task-${running.runId}`);
    const taskPath = script.match(/'@([^']+)'/)?.[1];
    assert.ok(taskPath);
    assert.equal((readFileSync(taskPath, "utf8").match(/Inspect exactly once/g) ?? []).length, 1);
    assert.equal(launch.env.PATH, process.env.PATH);
    assert.equal(launch.env.HERDR_APP_HOME, process.env.HERDR_APP_HOME);
  });
});

it("preserves classic detection precedence despite stale HC indicators", async () => {
  await coreFixture(async ({ dir }: any) => {
    writeFileSync(join(dir, "bin", "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    delete process.env.PI_SUBAGENT_MUX;
    process.env.HERDR_SOCKET_PATH = "/stale-classic.sock";
    process.env.HC_TERMINAL_SOCKET = "/stale-core.sock";
    assert.equal(getMuxBackend(), "herdr");
    process.env.PI_SUBAGENT_MUX = "herdr-core";
    delete process.env.HC_TERMINAL_ID;
    assert.equal(getMuxBackend(), null, "explicit Core must not fall back to classic");
  });
});

it("observes eventual app adoption without creating a replacement terminal", async () => {
  await coreFixture(async ({ ctx, stateFile, requests, appLog }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptPending: 2 }));
    const running = await __test__.launchSubagent({ name: "Delayed task", task: "inspect", tools: "read" }, ctx);
    assert.equal(running.surface, "t2");
    assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
    const calls = readFileSync(appLog, "utf8").trim().split("\n").map(line => JSON.parse(line).args);
    assert.ok(calls.filter(args => args[0] === "ls").length >= 4);
    assert.equal(requests.some((request: any) => request.method === "terminal.keys"), false, "Core startup must not send a command into a shell");
  });
});

it("preserves fork seeding and passes exactly one direct initial task on Core", async () => {
  await coreFixture(async ({ ctx }: any) => {
    const running = await __test__.launchSubagent({ name: "Fork", task: "One fork task", tools: "read", fork: true }, ctx);
    const script = readFileSync(running.launchScriptFile!, "utf8");
    assert.equal((script.match(/One fork task/g) ?? []).length, 1);
    assert.ok(readFileSync(running.sessionFile, "utf8").includes('"type":"session"'));
    assert.ok(running.transcriptStartLine > 0);
  });
});

it("rejects an unsupported parent runtime before Core or app mutation", async () => {
  await coreFixture(async ({ dir, ctx, requests }: any) => {
    process.argv[1] = join(dir, "unrelated.js");
    writeFileSync(process.argv[1], "// not Pi\n");
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect" }, ctx), /identifiable Node-hosted Pi/);
    assert.equal(requests.length, 0);
  });
});

it("rejects a mismapped app parent before terminal.run", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ badParent: true }));
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect" }, ctx), /parent address/);
    assert.equal(requests.some((request: any) => request.method === "terminal.run"), false);
  });
});

it("cleans only its owned child when app pane adoption fails", async () => {
  await coreFixture(async ({ stateFile, ctx, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true }));
    await assert.rejects(__test__.launchSubagent({ name: "Task", task: "inspect" }, ctx), /visibility setup failed/);
    assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
    const cleanup = requests.filter((request: any) => ["terminal.kill", "terminal.rm"].includes(request.method));
    assert.deepEqual(cleanup.map((request: any) => [request.method, request.params.terminal]), [["terminal.kill", "t2"], ["terminal.rm", "t2"]]);
  });
});

it("waits for the original wrapper and removes once after an accepted kill", async () => {
  await coreFixture(async ({ ctx, requests }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
    const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 999999, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
    recorder.record({ kind: "agent-ended" });
    writeFileSync(running.coreHost!.wrapperStartFile, JSON.stringify({ version: 1, runId: running.runId, wrapperPid: 456, address: "t2", observedAt: new Date().toISOString() }));
    let completed = false;
    const watcherAbort = new AbortController();
    const watcher = __test__.watchSubagent(running, watcherAbort.signal, { visibleInterval: 5, processProbe(pid: number) {
      if (pid === 999999) throw Object.assign(new Error("Pi disappeared"), { code: "ESRCH" });
    } }).then(result => { completed = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(completed, false, "Pi disappearance is not wrapper completion");
      const termination = await __test__.handleSubagentTerminate({ id: running.id });
      assert.equal(termination.details.status, "termination_requested_unconfirmed");
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 0);
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(completed, false, "native terminal state cannot complete a still-running original wrapper writer");
      writeFileSync(running.wrapperExitFile!, JSON.stringify({ version: 1, runId: running.runId, sourceId: `wrapper:${running.runId}`, sequence: 1, observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 143 } }));
      const result = await watcher;
      assert.equal(result.error, "terminated");
      assert.notEqual(result.exitCode, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(__test__.runningSubagents.has(running.id), false);
    } finally {
      watcherAbort.abort("test cleanup");
      await watcher;
      __test__.releaseRunningSubagent(running.id);
    }
  });
});

it("retains captured ownership and a private recovery descriptor when shutdown removal fails", async () => {
  await coreFixture(async ({ ctx, stateFile }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    writeFileSync(stateFile, JSON.stringify({ ...state, rmFails: true }));
    try {
      const failures = await __test__.shutdownOwnedSubagents("quit");
      assert.equal(failures.length, 1);
      assert.equal(__test__.runningSubagents.get(running.id)?.coreHost?.address, "t2");
      assert.ok(running.artifactDir, "owned Core launches must retain their artifact directory");
      const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(record.runId, running.runId);
      assert.equal(record.endpoint, running.coreHost!.endpoint);
      assert.equal(record.address, "t2");
      assert.equal(record.wrapperPid, 456);
      assert.equal(record.stage, "remove");
      assert.equal(record.script, running.launchScriptFile);
      assert.equal(record.session, running.sessionFile);
      assert.ok(statSync(file).size <= 64 * 1024);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.ok(failures[0].includes(file));
    } finally { __test__.releaseRunningSubagent(running.id); }
  });
});

for (const confirmed of [true, false]) {
  it(`delivers original Core output with ${confirmed ? "confirmed success" : "unknown exit, never success"}`, async () => {
    await coreFixture(async ({ ctx, requests }: any) => {
      const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
      __test__.registerRunningSubagent({ events: { emit() {} } } as any, running);
      mkdirSync(dirname(running.sessionFile), { recursive: true });
      writeFileSync(running.sessionFile, [
        { type: "session", id: running.id },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Original findings" }] } },
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
      const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 999999, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
      recorder.record({ kind: "completion-requested", reason: "done" }, { kind: "done" });
      recorder.record({ kind: "agent-settled" });
      writeFileSync(running.coreHost!.wrapperStartFile, JSON.stringify({ version: 1, runId: running.runId, wrapperPid: 456, address: "t2", observedAt: new Date().toISOString() }));
      if (confirmed) writeFileSync(running.wrapperExitFile!, JSON.stringify({ version: 1, runId: running.runId, sourceId: `wrapper:${running.runId}`, sequence: 1, observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 0 } }));
      const result = await __test__.watchSubagent(running, new AbortController().signal, { visibleInterval: 5, processProbe() { throw Object.assign(new Error("Original wrapper gone"), { code: "ESRCH" }); } });
      assert.ok(result.summary.includes("Original findings"));
      assert.equal(result.exitCode === 0, confirmed);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(__test__.runningSubagents.has(running.id), false);
    });
  });
}

function registeredRuntime(ctx: any) {
  const tools: any[] = [];
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  subagentsExtension({
    events: { emit() {}, on() { return () => {}; } }, on(name: string, handler: any) { handlers.set(name, handler); },
    registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    sendMessage(message: any) { messages.push(message); }, getAllTools() { return []; },
  } as any);
  handlers.get("session_start")({}, ctx);
  return { tools, handlers, messages, launch: (params: any) => tools.find(tool => tool.name === "subagent").execute("launch", params, undefined, undefined, ctx) };
}

it("retains failed visibility cleanup from the registered tool and retries only removal", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, rmFails: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
      assert.equal(__test__.runningSubagents.size, 1, "failed setup must remain directly owned");
      assert.equal(getDirectChildCount(), 1);
      const running = [...__test__.runningSubagents.values()][0];
      assert.equal(running.coreHost?.address, "t2");
      assert.equal(running.coreCleanupStage, "remove");
      const termination = await runtime.tools.find(tool => tool.name === "subagent_terminate").execute("terminate", { id: running.id }, undefined, undefined, ctx);
      assert.equal(termination.details.status, "termination_requested_unconfirmed");
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1, "an already accepted setup kill must not be repeated by controls");
      writeFileSync(stateFile, JSON.stringify({ child: true, adoptionFails: true, rmFails: false }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 2);
      assert.equal(runtime.messages.length, 0, "a failed launch must not deliver a second completion result");
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("retains an unconfirmed registered launch and reconciles its exact run without relaunching", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChild: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /launch .* is unconfirmed/);
      assert.equal(__test__.runningSubagents.size, 1, "unconfirmed launches remain directly owned");
      assert.equal(getDirectChildCount(), 1);
      const running = [...__test__.runningSubagents.values()][0];
      assert.equal(running.coreHost, undefined);
      assert.equal(running.coreLaunchPending?.context.endpoint, process.env.HC_TERMINAL_SOCKET);
      assert.equal(running.coreLaunchPending?.context.coreId, "test-core");
      assert.equal(running.coreLaunchPending?.context.parent, "t1");
      const launch = requests.find((request: any) => request.method === "terminal.run");
      assert.equal(running.coreLaunchPending?.runId, launch.params.labels["pi.subagent.run"]);
      assert.equal(running.coreLaunchPending?.scriptPath, launch.params.argv[1]);
      assert.ok(running.coreLaunchPending?.wrapperStartFile.endsWith(".wrapper-start.json"));
      writeFileSync(stateFile, JSON.stringify({ child: true, unconfirmed: true, hideChild: false }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.deepEqual(requests.filter((request: any) => ["terminal.kill", "terminal.rm"].includes(request.method)).map((request: any) => request.params.terminal), ["t2", "t2"]);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("preserves ambiguous launch ownership and full correlation in a private shutdown descriptor", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChild: true }));
    const runtime = registeredRuntime(ctx);
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = message => { stderr.push(String(message)); };
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /is unconfirmed/);
      assert.equal(__test__.runningSubagents.size, 1);
      const running = [...__test__.runningSubagents.values()][0];
      const interrupt = await runtime.tools.find(tool => tool.name === "subagent_interrupt").execute("escape", { id: running.id }, undefined, undefined, ctx);
      assert.equal(interrupt.details.error, "launch-unconfirmed");
      const terminate = await runtime.tools.find(tool => tool.name === "subagent_terminate").execute("terminate", { id: running.id }, undefined, undefined, ctx);
      assert.equal(terminate.details.error, "launch-unconfirmed");
      writeFileSync(stateFile, JSON.stringify({ child: true, ambiguous: true }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 1);
      const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(record.runId, running.runId);
      assert.equal(record.endpoint, running.coreLaunchPending!.context.endpoint);
      assert.equal(record.coreId, "test-core");
      assert.equal(record.parent, "t1");
      assert.equal(record.script, running.coreLaunchPending!.scriptPath);
      assert.equal(record.wrapperStartFile, running.coreLaunchPending!.wrapperStartFile);
      assert.equal(record.session, running.sessionFile);
      assert.equal(record.address, undefined, "ambiguous addresses must not become owned addresses");
      assert.equal(record.wrapperPid, undefined, "current/recovery PID must not become original identity");
      assert.equal(record.stage, "reconcile");
      assert.ok(statSync(file).size <= 64 * 1024);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(stderr.filter(message => message.includes(file)).length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.some((request: any) => ["terminal.kill", "terminal.rm", "terminal.keys"].includes(request.method)), false);
      assert.equal(runtime.messages.length, 0);
    } finally {
      console.error = originalError;
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

async function waitUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(check(), "bounded fake cleanup observation timed out");
}

it("cleans a retained setup once when an actual module reload aborts the old runtime", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, rmFails: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
      assert.equal(__test__.runningSubagents.size, 1);
      writeFileSync(stateFile, JSON.stringify({ child: true, rmFails: false }));
      const replacement = await import("../pi-extension/subagents/index.ts?retained-core-reload");
      await waitUntil(() => __test__.runningSubagents.size === 0);
      assert.equal(replacement.__test__.runningSubagents.size, 0);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 2);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("cleans an unconfirmed in-flight setup that settles after the shutdown snapshot", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChildOnce: true, delayRunReply: true }));
    const runtime = registeredRuntime(ctx);
    try {
      const rejected = assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /is unconfirmed/);
      await waitUntil(() => requests.some((request: any) => request.method === "terminal.run"));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      runtime.handlers.get("session_start")({}, ctx);
      await rejected;
      await waitUntil(() => requests.some((request: any) => request.method === "terminal.rm") && __test__.runningSubagents.size === 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

for (const stage of ["kill", "remove"] as const) {
  it(`describes pre-registration visibility ${stage} failure with its known original identity`, async () => {
    await coreFixture(async ({ ctx, stateFile }: any) => {
      writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, killFails: stage === "kill", rmFails: stage === "remove" }));
      const runtime = registeredRuntime(ctx);
      const stderr: string[] = [];
      const originalError = console.error;
      console.error = message => { stderr.push(String(message)); };
      try {
        await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
        assert.equal(getDirectChildCount(), 1);
        const running = [...__test__.runningSubagents.values()][0];
        const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 789, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
        recorder.record({ kind: "agent-ended" });
        await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
        const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
        const record = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(record.address, "t2");
        assert.equal(record.coreId, "test-core");
        assert.equal(record.parent, "t1");
        assert.equal(record.endpoint, running.coreHost!.endpoint);
        assert.equal(record.wrapperPid, 456);
        assert.equal(record.childPid, 789);
        assert.equal(record.script, running.launchScriptFile);
        assert.equal(record.wrapperStartFile, running.coreHost!.wrapperStartFile);
        assert.equal(record.stage, stage);
        assert.equal(__test__.runningSubagents.size, 1);
        assert.equal(stderr.filter(message => message.includes(file)).length, 1);
        assert.equal(runtime.messages.length, 0);
      } finally {
        console.error = originalError;
        for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
        await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      }
    });
  });
}

it("retains failed registered resume setup under the resumed session identity", async () => {
  await coreFixture(async ({ dir, ctx, stateFile, requests }: any) => {
    const sessionPath = join(dir, "resume-failed.jsonl");
    writeFileSync(sessionPath, [
      { type: "session", id: "old-session", cwd: dir },
      { type: "custom", customType: "pi-interactive-subagents.resume-policy", data: {
        version: 2, sessionId: "old-session", agent: null, deniedTools: ["bash"], cwd: dir,
        agentDir: process.env.PI_CODING_AGENT_DIR, systemPrompt: null, requestedSkills: [], activeTools: ["read"], skills: [],
      } },
    ].map(value => JSON.stringify(value)).join("\n") + "\n");
    writeFileSync(stateFile, JSON.stringify({ unconfirmed: true, hideChild: true }));
    const runtime = registeredRuntime(ctx);
    try {
      await assert.rejects(runtime.tools.find(tool => tool.name === "subagent_resume").execute("resume", { sessionPath, name: "Resume failed", message: "Continue once" }, undefined, undefined, ctx), /is unconfirmed/);
      assert.equal(getDirectChildCount(), 1);
      const running = [...__test__.runningSubagents.values()][0];
      assert.equal(running.sessionFile, sessionPath);
      assert.equal(running.task, "Continue once");
      writeFileSync(stateFile, JSON.stringify({ child: true, hideChild: false }));
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.equal(requests.filter((request: any) => request.method === "terminal.run").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 1);
      assert.equal(runtime.messages.length, 0);
    } finally {
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("preserves failed reload cleanup in a recovery descriptor without a completion delivery", async () => {
  await coreFixture(async ({ ctx, stateFile, requests }: any) => {
    writeFileSync(stateFile, JSON.stringify({ adoptionFails: true, rmFails: true }));
    const runtime = registeredRuntime(ctx);
    const stderr: string[] = [];
    const originalError = console.error;
    console.error = message => { stderr.push(String(message)); };
    try {
      await assert.rejects(runtime.launch({ name: "Task", task: "inspect", tools: "read" }), /visibility setup failed/);
      const running = [...__test__.runningSubagents.values()][0];
      const file = join(running.artifactDir!, "subagent-completion", `${running.runId}.recovery.json`);
      await import("../pi-extension/subagents/index.ts?retained-core-reload-failure");
      await waitUntil(() => stderr.some(message => message.includes(file)));
      const record = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(record.address, "t2");
      assert.equal(record.coreId, "test-core");
      assert.equal(record.parent, "t1");
      assert.equal(record.runId, running.runId);
      assert.equal(record.stage, "remove");
      assert.equal(__test__.runningSubagents.size, 1);
      assert.equal(stderr.filter(message => message.includes(file)).length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.kill").length, 1);
      assert.equal(requests.filter((request: any) => request.method === "terminal.rm").length, 2);
      assert.equal(runtime.messages.length, 0);
    } finally {
      console.error = originalError;
      for (const id of __test__.runningSubagents.keys()) __test__.releaseRunningSubagent(id);
      await runtime.handlers.get("session_shutdown")({ reason: "quit" }, ctx);
    }
  });
});

it("does not infer original process exit from a missing Core registry record with unknown startup identity", async () => {
  await coreFixture(async ({ ctx, stateFile }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    writeFileSync(stateFile, JSON.stringify({ child: true, missingChild: true }));
    const abort = new AbortController();
    let completed = false;
    let ticks = 0;
    const waiting = waitForVisibleCompletion({
      state: running.completionState!, childSnapshotFile: running.childSnapshotFile!, wrapperExitFile: running.wrapperExitFile!,
      sessionFile: running.sessionFile, transcriptStartLine: 0, signal: abort.signal, coreHost: running.coreHost,
      interval: 5, processProbe() { throw Object.assign(new Error("unknown PID"), { code: "ESRCH" }); }, onTick() { ticks++; },
    }).then(result => { completed = true; return result; });
    try {
      await waitUntil(() => completed || ticks > 0);
      assert.equal(completed, false, "registry absence alone is not original process-exit evidence");
      assert.notEqual(running.completionState!.core.process.status, "exited");
    } finally { abort.abort("test cleanup"); await waiting.catch(() => {}); }
  });
});

it("keeps wrapper loss unconfirmed while known Pi lives and rereads final sidecars after proof", async () => {
  await coreFixture(async ({ ctx }: any) => {
    const running = await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
    const recorder = createChildCompletionRecorder({ runId: running.runId, childPid: 789, sessionFile: running.sessionFile, snapshotFile: running.childSnapshotFile! });
    recorder.record({ kind: "agent-ended" });
    writeFileSync(running.coreHost!.wrapperStartFile, JSON.stringify({ version: 1, runId: running.runId, wrapperPid: 456, address: "t2", observedAt: new Date().toISOString() }));
    mkdirSync(dirname(running.sessionFile), { recursive: true });
    writeFileSync(running.sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Original output" }] } }) + "\n");
    const abort = new AbortController();
    let completed = false;
    let piAlive = true;
    let ticks = 0;
    const probed: number[] = [];
    const waiting = waitForVisibleCompletion({
      state: running.completionState!, childSnapshotFile: running.childSnapshotFile!, wrapperExitFile: running.wrapperExitFile!,
      sessionFile: running.sessionFile, transcriptStartLine: 0, signal: abort.signal, coreHost: running.coreHost,
      interval: 5, onTick() { ticks++; }, processProbe(pid: number) {
        probed.push(pid);
        if (pid === 789 && piAlive) return;
        if (pid === 789) writeFileSync(running.wrapperExitFile!, JSON.stringify({ version: 1, runId: running.runId, sourceId: `wrapper:${running.runId}`, sequence: 1, observedAt: new Date().toISOString(), exit: { kind: "shell", shellStatus: 7 } }));
        throw Object.assign(new Error("original process gone"), { code: "ESRCH" });
      },
    }).then(result => { completed = true; return result; });
    try {
      await waitUntil(() => completed || ticks > 0);
      assert.equal(completed, false, "wrapper absence must not imply exit of a known live original Pi");
      assert.ok(probed.includes(789));
      assert.notEqual(running.completionState!.core.process.status, "exited");
      piAlive = false;
      await waitUntil(() => completed);
      const result = await waiting;
      assert.deepEqual(result.completion.processExit, { kind: "shell", shellStatus: 7 }, "final sidecar must beat the first-exit-wins absence fallback");
      assert.equal(result.completion.output, "Original output");
    } finally { abort.abort("test cleanup"); await waiting.catch(() => {}); }
  });
});

for (const defaultHome of ["xdg", "home"] as const) {
  it(`pins the parent's ${defaultHome} default app home over a conflicting Core service environment`, async () => {
    await coreFixture(async ({ dir, ctx, stateFile, requests, appLog }: any) => {
      process.env.HOME = join(dir, "parent-home");
      process.env.XDG_CONFIG_HOME = defaultHome === "xdg" ? join(dir, "parent-config") : "";
      if (defaultHome === "xdg") delete process.env.HERDR_APP_HOME;
      else process.env.HERDR_APP_HOME = "";
      const expected = defaultHome === "xdg" ? join(dir, "parent-config", "herdr-app") : join(dir, "parent-home", ".config", "herdr-app");
      const staleServerHome = join(dir, "stale-server-app");
      writeFileSync(stateFile, JSON.stringify({ coreServerHome: staleServerHome }));
      await __test__.launchSubagent({ name: "Task", task: "inspect", tools: "read" }, ctx);
      const state = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.equal(state.childHome, expected, "overlay must not reintroduce the server's different app selection into nested Pi");
      const launch = requests.find((request: any) => request.method === "terminal.run");
      assert.equal(launch.params.env.HERDR_APP_HOME, expected);
      const appCalls = readFileSync(appLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(appCalls.every(call => call.home === expected), "preflight/adoption and nested child must use the same recorded home");
    });
  });
}

it("rejects foreign cli metadata before accessing native context", async () => {
  await coreFixture(async ({ dir, ctx, requests }: any) => {
    const agents = join(process.env.PI_CODING_AGENT_DIR!, "agents"); mkdirSync(agents);
    writeFileSync(join(agents, "review.md"), "---\nname: review\ncli: claude\nmodel: sonnet\nauto-exit: true\nspawning: false\nsystem-prompt: append\n---\nReview only.\n");
    await assert.rejects(__test__.launchSubagent({ name: "Review", agent: "review", task: "inspect" }, ctx), /cli/i);
    assert.equal(requests.length, 0);
  });
});
