import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CheckReport, heartbeatRecord, assessHeartbeat } from '../src/guards.js';
import { evaluateErrorRate } from '../examples/error-rate.js';
import { scanManifests } from '../examples/scan-manifests.js';

const now = new Date('2026-01-02T12:00:00.000Z');
const record = () => heartbeatRecord({ job: 'synthetic-check', verdict: 'pass', now });

test('coverage configuration rejects coercion and unsafe integers', () => {
  for (const maxSkipRatio of ['0.5', null, true, NaN, Infinity, -0.1, 1]) {
    assert.throws(() => new CheckReport('check', { maxSkipRatio }), RangeError);
  }
  for (const minTargets of ['1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.5, 0]) {
    assert.throws(() => new CheckReport('check', { minTargets }), RangeError);
  }
});

test('identifiers, check names and finding messages cannot silently coerce', () => {
  for (const bad of [undefined, null, false, 1, {}, [], '', '  ']) {
    assert.throws(() => new CheckReport(bad), TypeError);
    const report = new CheckReport('check');
    assert.throws(() => report.scanned(bad), TypeError);
    assert.equal(report.finish().discovered, 0);
    assert.throws(() => report.finding('id', bad, { kind: 'unverifiable' }), TypeError);
    // Refusing the invalid message must not consume the target id.
    report.scanned('id');
    assert.equal(report.finish().status, 'pass');
  }
});

test('returned finding and skip objects cannot rewrite later report summaries', () => {
  const report = new CheckReport('check');
  report.scanned('one');
  report.finding('one', 'known violation');
  report.skipped('two', 'intentional skip');
  const first = report.finish();
  first.findings[0].kind = 'unverifiable';
  first.findings[0].message = 'rewritten';
  first.skipped[0].reason = 'rewritten';
  const second = report.finish();
  assert.deepEqual(second.findings, [{ id: 'one', kind: 'violation', message: 'known violation' }]);
  assert.equal(second.skipped[0].reason, 'intentional skip');
  assert.equal(second.discovered, 2);
});

test('error-rate options must remain finite numeric policy values', () => {
  for (const threshold of ['0.01', null, NaN, Infinity, -0.1, 1.1]) {
    assert.throws(() => evaluateErrorRate([], { threshold }), RangeError);
  }
  for (const expectBuckets of ['12', NaN, Infinity, 0, -1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => evaluateErrorRate([], { expectBuckets }), RangeError);
  }
});

test('invalid counts never become a clean rate or a zero-traffic skip', () => {
  const good = { bucket: 'synthetic-bucket', requests: 100, errors: 0 };
  for (const sample of [null, [], {}, { ...good, bucket: '' }, { ...good, requests: '100' },
    { ...good, requests: -1 }, { ...good, requests: NaN }, { ...good, errors: NaN },
    { ...good, errors: -1 }, { ...good, errors: '0' }, { ...good, errors: 101 },
    { ...good, errors: 0.5 }, { ...good, requests: Infinity }, { ...good, requests: 0, errors: 1 }]) {
    assert.throws(() => evaluateErrorRate([sample], { expectBuckets: 1 }), TypeError);
  }
  for (const input of [null, {}, 'not rows']) assert.throws(() => evaluateErrorRate(input), TypeError);
  assert.equal(evaluateErrorRate([good], { expectBuckets: 1, threshold: 0 }).status, 'pass');
  assert.equal(evaluateErrorRate([{ ...good, requests: 0 }], { expectBuckets: 1 }).status, 'inconclusive');
});

test('parseable but invalid manifests produce unverifiable findings', () => {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'guard-schema-'));
  assert.equal(dirname(directory), temporaryRoot);
  try {
    const invalid = [null, [], {}, { auth: {} }, { auth: { mode: '' } },
      { auth: { mode: 7 } }, { auth: { mode: 'oidc' }, checks: [] },
      { auth: { mode: 'oidc' }, checks: { skip: true } },
      { auth: { mode: 'oidc' }, checks: { skip: ' ' } }];
    invalid.forEach((value, index) => writeFileSync(join(directory, `bad-${index}.json`), JSON.stringify(value)));
    writeFileSync(join(directory, 'good.json'), JSON.stringify({ auth: { mode: 'oidc' } }));
    const result = scanManifests(directory);
    assert.equal(result.status, 'fail');
    assert.equal(result.scanned, 1);
    assert.equal(result.discovered, invalid.length + 1);
    assert.equal(result.skipped.length, 0);
    assert.equal(result.findings.length, invalid.length);
    assert.ok(result.findings.every((finding) => finding.kind === 'unverifiable'));
  } finally {
    assert.equal(dirname(directory), temporaryRoot);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh timestamps without a valid conclusive record are invalid', () => {
  for (const bad of [true, [], 'record', { ...record(), job: '' }, { ...record(), job: 7 },
    { ...record(), verdict: 'inconclusive' }, { ...record(), verdict: undefined },
    { ...record(), runId: {} }, { ...record(), runId: '' },
    { lastConclusiveRunAt: now.toISOString() }]) {
    assert.equal(assessHeartbeat(bad, { maxAgeHours: 1, now }).status, 'invalid');
  }
});

test('heartbeat timestamps reject ambiguous, coercible and normalized invalid dates', () => {
  for (const timestamp of [null, 0, now.getTime(), '2026-01-02', '2026-01-02T12:00:00',
    '2026-02-30T00:00:00Z', 'garbage']) {
    assert.equal(assessHeartbeat({ ...record(), lastConclusiveRunAt: timestamp }, { maxAgeHours: 24, now }).status, 'invalid');
  }
  assert.equal(assessHeartbeat({ ...record(), lastConclusiveRunAt: '2026-01-02T12:00:00Z' }, { maxAgeHours: 24, now }).status, 'fresh');
});

test('heartbeat configuration and caller time cannot create a false fresh result', () => {
  for (const maxAgeHours of ['24', null, NaN, Infinity, 0, -1]) {
    assert.throws(() => assessHeartbeat(record(), { maxAgeHours, now }), RangeError);
  }
  for (const badTime of [new Date(NaN), now.toISOString(), null, 0]) {
    assert.throws(() => assessHeartbeat(record(), { maxAgeHours: 24, now: badTime }), TypeError);
    assert.throws(() => heartbeatRecord({ job: 'job', verdict: 'pass', now: badTime }), TypeError);
  }
  for (const job of ['', ' ', true, {}, 1]) {
    assert.throws(() => heartbeatRecord({ job, verdict: 'pass', now }), TypeError);
  }
});
