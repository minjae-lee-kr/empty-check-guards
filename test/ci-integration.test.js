import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { touch } from '../examples/heartbeat.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = join(root, 'examples/ci-manifests.js');
function scratch(t) {
  const parent = resolve(tmpdir());
  const path = mkdtempSync(join(parent, 'guards-ci-'));
  assert.equal(dirname(path), parent);
  t.after(() => { assert.equal(dirname(path), parent); rmSync(path, { recursive: true, force: true }); });
  const heartbeat = join(path, 'heartbeat.json');
  touch(heartbeat, { job: 'previous-run', runId: 'preserve-me', verdict: 'pass', now: new Date('2026-01-01T00:00:00Z') });
  const previous = readFileSync(heartbeat);
  const empty = join(path, 'empty'); mkdirSync(empty);
  return { path, heartbeat, previous, empty };
}
function run(directory, heartbeat, flags = [], env = process.env) {
  const result = spawnSync(process.execPath, [runner, directory, heartbeat, ...flags], {
    cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return { code: result.status, report: JSON.parse(result.stdout) };
}
const fixture = (name) => join(root, 'fixtures/manifests', name);

test('actual pass and fail reports both refresh heartbeat and preserve their process verdict', (t) => {
  const context = scratch(t);
  for (const [name, status, code] of [['clean', 'pass', 0], ['with-findings', 'fail', 1]]) {
    const observed = run(fixture(name), context.heartbeat);
    assert.equal(observed.code, code);
    assert.equal(observed.report.status, 'checked');
    assert.equal(observed.report.check.status, status);
    assert.equal(observed.report.check.exitCode, code);
    assert.equal(observed.report.heartbeat, 'written');
    const persisted = JSON.parse(readFileSync(context.heartbeat, 'utf8'));
    assert.equal(persisted.verdict, status);
    assert.equal(persisted.runId, observed.report.runId);
  }
});

test('inconclusive and overridden inconclusive leave the previous heartbeat byte-identical', (t) => {
  const context = scratch(t);
  for (const [flags, code] of [[[], 2], [['--override-by', 'fixture-actor', '--override-reason', 'empty fixture'], 0]]) {
    const observed = run(context.empty, context.heartbeat, flags);
    assert.equal(observed.code, code);
    assert.equal(observed.report.check.status, 'inconclusive');
    assert.equal(observed.report.heartbeat, 'unchanged');
    assert.ok(readFileSync(context.heartbeat).equals(context.previous));
  }
});

function faultEnvironment(path, code) {
  const preload = join(path, 'fault.cjs');
  // The parent integration example stays intact. Only the actual scan child is
  // faulted; no executable or shell injection option is added to production code.
  writeFileSync(preload, `if (require('node:path').basename(process.argv[1] || '') === 'scan-manifests.js') { ${code}\n }\n`);
  return { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}` };
}

test('a pre-main throw cannot impersonate a completed fail verdict or reuse a previous artifact', (t) => {
  const context = scratch(t);
  writeFileSync(join(context.path, 'report.json'), JSON.stringify({ status: 'pass', exitCode: 0 }));
  const observed = run(fixture('clean'), context.heartbeat, [], faultEnvironment(context.path, "throw new Error('synthetic startup failure');"));
  assert.equal(observed.code, 2);
  assert.equal(observed.report.child.status, 1);
  assert.equal(observed.report.child.stderrPresent, true);
  assert.equal(observed.report.stage, 'process');
  assert.equal(observed.report.check, undefined);
  assert.ok(readFileSync(context.heartbeat).equals(context.previous));
});

test('a truncated report and a valid report with the wrong process status do not refresh heartbeat', (t) => {
  const context = scratch(t);
  for (const [name, fault] of [
    ['clean', "const write = process.stdout.write.bind(process.stdout); process.stdout.write = (chunk, ...args) => write(String(chunk).slice(0, 12), ...args);"],
    ['clean', "const write = process.stdout.write.bind(process.stdout); process.stdout.write = (chunk, ...args) => write(JSON.stringify({ status: 'pass', exitCode: 0 }), ...args);"],
    ['with-findings', "process.on('beforeExit', () => { process.exitCode = 0; });"],
  ]) {
    const observed = run(fixture(name), context.heartbeat, [], faultEnvironment(context.path, fault));
    assert.equal(observed.code, 2);
    assert.equal(observed.report.stage, 'report');
    assert.equal(observed.report.check, undefined);
    assert.ok(readFileSync(context.heartbeat).equals(context.previous));
  }
});

test('a fail JSON followed by an uncaught exception or pipe error is not a completed verdict', (t) => {
  const context = scratch(t);
  for (const fault of [
    "process.once('beforeExit', () => { throw new Error('synthetic post-report failure'); });",
    "process.once('beforeExit', () => { process.stdout.emit('error', Object.assign(new Error('synthetic post-report pipe failure'), { code: 'EPIPE' })); });",
  ]) {
    const observed = run(fixture('with-findings'), context.heartbeat, [], faultEnvironment(context.path, fault));
    assert.equal(observed.code, 2);
    assert.equal(observed.report.child.status, 1, 'The crash collides with the legitimate fail exit code.');
    assert.equal(observed.report.child.stderrPresent, true);
    assert.equal(observed.report.stage, 'process');
    assert.equal(observed.report.check, undefined);
    assert.ok(readFileSync(context.heartbeat).equals(context.previous));
  }
});

test('a terminated child and heartbeat persistence failure stay integration errors', (t) => {
  const context = scratch(t);
  const terminated = run(fixture('clean'), context.heartbeat, [], faultEnvironment(context.path, "process.kill(process.pid, 'SIGTERM');"));
  assert.equal(terminated.code, 2);
  // Windows may expose forced termination as a numeric exit instead of a POSIX
  // signal. Either observation must fail closed without inventing a verdict.
  assert.equal(terminated.report.stage, terminated.report.child.signal === null ? 'report' : 'process');
  assert.equal(terminated.report.check, undefined);
  assert.ok(readFileSync(context.heartbeat).equals(context.previous));
  const unwritable = join(context.path, 'existing-directory'); mkdirSync(unwritable);
  const failedWrite = run(fixture('clean'), unwritable);
  assert.equal(failedWrite.code, 2);
  assert.equal(failedWrite.report.stage, 'heartbeat');
  assert.equal(failedWrite.report.heartbeat, 'unconfirmed');
  assert.equal(failedWrite.report.check.status, 'pass', 'Keep the real check verdict distinct from integration failure.');
});

test('a Bash -e step can retain a completed failure heartbeat before the step exits', { skip: process.platform === 'win32' ? 'POSIX CI shell control; Windows runner controls are exercised above.' : false }, (t) => {
  const context = scratch(t);
  const script = join(context.path, 'step.sh');
  writeFileSync(script, '"$NODE_EXE" "$RUNNER" "$MANIFEST_DIR" "$HEARTBEAT_FILE"\nprintf "must not execute after a fail verdict\\n"\n');
  const child = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, NODE_EXE: process.execPath, RUNNER: runner, MANIFEST_DIR: fixture('with-findings'), HEARTBEAT_FILE: context.heartbeat },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(JSON.parse(child.stdout).check.status, 'fail');
  assert.equal(JSON.parse(readFileSync(context.heartbeat, 'utf8')).verdict, 'fail');
});
