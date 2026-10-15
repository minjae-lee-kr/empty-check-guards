import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanManifests } from '../examples/scan-manifests.js';
import { evaluateErrorRate } from '../examples/error-rate.js';
import { touch, check } from '../examples/heartbeat.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (p) => join(root, 'fixtures', p);
const run = (script, ...args) => spawnSync(process.execPath, [join(root, 'examples', script), ...args], { encoding: 'utf8' });

describe('example 1: scan-manifests', () => {
  test('clean directory passes', () => {
    const s = scanManifests(fx('manifests/clean'));
    assert.equal(s.status, 'pass');
    assert.equal(s.scanned, 3);
  });

  test('deprecated auth is a violation, an unparseable manifest is unverifiable; both fail the run', () => {
    const s = scanManifests(fx('manifests/with-findings'));
    assert.equal(s.status, 'fail');
    assert.deepEqual(s.findings.map((f) => [f.id, f.kind]).sort(), [['beta', 'violation'], ['gamma', 'unverifiable']]);
    assert.equal(s.discovered, 3);
    assert.equal(s.scanned, 2);
  });

  test('empty directory is inconclusive, exit 2', () => {
    const s = scanManifests(fx('manifests/empty'));
    assert.equal(s.status, 'inconclusive');
    assert.equal(s.exitCode, 2);
    assert.deepEqual(s.coverage.reasons, ['no targets were discovered']);
  });

  test('a directory that does not exist is inconclusive with a source error, not a crash and not a pass', () => {
    const s = scanManifests(fx('manifests/does-not-exist'));
    assert.equal(s.status, 'inconclusive');
    assert.equal(s.exitCode, 2);
    assert.match(s.coverage.reasons[0], /target source unavailable: cannot read .*ENOENT/);
  });

  test('mostly-skipped directory is inconclusive and lists every skip reason', () => {
    const s = scanManifests(fx('manifests/mostly-skipped'));
    assert.equal(s.status, 'inconclusive');
    assert.equal(s.skipped.length, 2);
    assert.ok(s.skipped.every((k) => k.reason.length > 0));
    // the two skipped services actually violate the policy; a high skip ratio cannot be a pass
    assert.equal(s.findings.length, 0);
  });

  test('CLI exit codes: pass 0, fail 1, inconclusive 2, override 0 with trace', () => {
    assert.equal(run('scan-manifests.js', fx('manifests/clean')).status, 0);
    assert.equal(run('scan-manifests.js', fx('manifests/with-findings')).status, 1);
    const empty = run('scan-manifests.js', fx('manifests/empty'));
    assert.equal(empty.status, 2);
    assert.match(empty.stdout, /\[INCONCLUSIVE\]/);
    const over = run('scan-manifests.js', fx('manifests/empty'), '--override-by', 'alice', '--override-reason', 'fresh environment');
    assert.equal(over.status, 0);
    assert.match(over.stdout, /\[INCONCLUSIVE\][\s\S]*OVERRIDE recorded, by "alice": fresh environment/);
  });

  test('CLI: an override on a failing run is refused and the exit code stays 1', () => {
    const r = run('scan-manifests.js', fx('manifests/with-findings'), '--override-by', 'alice', '--override-reason', 'please');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /override refused: run is fail/);
  });

  test('CLI refuses a half-specified override', () => {
    const r = run('scan-manifests.js', fx('manifests/empty'), '--override-by', 'alice');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must be given together/);
  });

  test('CLI --json emits the summary object with coverage and findings', () => {
    const r = run('scan-manifests.js', fx('manifests/with-findings'), '--json');
    assert.equal(r.status, 1);
    const s = JSON.parse(r.stdout);
    assert.equal(s.status, 'fail');
    assert.equal(s.coverage.sufficient, true);
    assert.equal(s.findings.length, 2);
  });
});

describe('example 2: error-rate', () => {
  const load = (n) => JSON.parse(readFileSync(fx(`samples/${n}.json`), 'utf8'));

  test('healthy hour passes with all 12 buckets scanned', () => {
    const s = evaluateErrorRate(load('healthy'));
    assert.equal(s.status, 'pass');
    assert.equal(s.scanned, 12);
  });

  test('an hour with zero requests everywhere is inconclusive, not "0 errors"', () => {
    const s = evaluateErrorRate(load('no_traffic'));
    assert.equal(s.status, 'inconclusive');
    assert.equal(s.scanned, 0);
    assert.equal(s.skipped.length, 12);
  });

  test('only 5 of 12 buckets present is inconclusive', () => {
    const s = evaluateErrorRate(load('gap'));
    assert.equal(s.status, 'inconclusive');
    assert.match(s.coverage.reasons[0], /only 5 target\(s\).*minimum 11/);
  });

  test('a real spike fails with the offending buckets named', () => {
    const s = evaluateErrorRate(load('spike'));
    assert.equal(s.status, 'fail');
    assert.equal(s.findings.length, 2);
  });

  test('a spike inside an incomplete window fails and still reports the gap', () => {
    const s = evaluateErrorRate(load('spike').slice(5, 10));
    assert.equal(s.status, 'fail');
    assert.equal(s.coverage.sufficient, false);
  });

  test('an empty array (query returned no rows) is inconclusive', () => {
    assert.equal(evaluateErrorRate([]).status, 'inconclusive');
  });

  test('a duplicated bucket is an upstream bug and throws', () => {
    const two = load('healthy').slice(0, 2);
    assert.throws(() => evaluateErrorRate([...two, two[0]]), /already recorded/);
  });

  test('CLI exit codes: healthy 0, spike 1, no traffic 2, duplicate 2', () => {
    assert.equal(run('error-rate.js', fx('samples/healthy.json')).status, 0);
    assert.equal(run('error-rate.js', fx('samples/spike.json')).status, 1);
    const quiet = run('error-rate.js', fx('samples/no_traffic.json'));
    assert.equal(quiet.status, 2);
    assert.match(quiet.stdout, /\[INCONCLUSIVE\]/);
  });
});

describe('example 3: heartbeat', () => {
  test('a missing file is exit 2; touch with a verdict then check is fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'));
    const file = join(dir, 'nightly.json');
    const missing = run('heartbeat.js', 'check', file, '--max-age-hours', '24');
    assert.equal(missing.status, 2);
    assert.match(missing.stdout, /\[MISSING\]/);

    const noVerdict = run('heartbeat.js', 'touch', file, '--job', 'nightly');
    assert.equal(noVerdict.status, 2);
    assert.match(noVerdict.stderr, /conclusive run/);
    assert.equal(run('heartbeat.js', 'check', file, '--max-age-hours', '24').status, 2, 'a refused touch must not create a record');

    assert.equal(run('heartbeat.js', 'touch', file, '--job', 'nightly', '--verdict', 'fail').status, 0);
    const fresh = run('heartbeat.js', 'check', file, '--max-age-hours', '24');
    assert.equal(fresh.status, 0);
    assert.match(fresh.stdout, /\[FRESH\].*verdict fail/);
  });

  test('a record older than the limit is stale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-'));
    const file = join(dir, 'nightly.json');
    touch(file, { job: 'nightly', verdict: 'pass', now: new Date('2026-01-01T00:00:00Z') });
    const a = check(file, { maxAgeHours: 24, now: new Date('2026-01-03T00:00:00Z') });
    assert.equal(a.status, 'stale');
  });
});
