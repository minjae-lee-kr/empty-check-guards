import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CheckReport, Status, ExitCode, FindingKind, formatReport,
  heartbeatRecord, assessHeartbeat, Heartbeat, heartbeatExitCode,
} from '../src/guards.js';

describe('CheckReport verdicts', () => {
  test('zero targets is INCONCLUSIVE, never PASS', () => {
    const s = new CheckReport('t').finish();
    assert.equal(s.status, Status.INCONCLUSIVE);
    assert.equal(s.exitCode, 2);
    assert.deepEqual(s.coverage, { sufficient: false, reasons: ['no targets were discovered'] });
  });

  test('enough scanned targets and no findings is PASS', () => {
    const r = new CheckReport('t', { minTargets: 2 });
    r.scanned('a'); r.scanned('b');
    const s = r.finish();
    assert.equal(s.status, Status.PASS);
    assert.equal(s.exitCode, 0);
    assert.equal(s.coverage.sufficient, true);
  });

  test('fewer scanned than minTargets is INCONCLUSIVE even with no findings', () => {
    const r = new CheckReport('t', { minTargets: 3 });
    r.scanned('a'); r.scanned('b');
    const s = r.finish();
    assert.equal(s.status, Status.INCONCLUSIVE);
    assert.match(s.coverage.reasons[0], /only 2 target\(s\).*minimum 3/);
  });

  test('a finding makes the run FAIL', () => {
    const r = new CheckReport('t');
    r.scanned('a'); r.finding('a', 'bad');
    const s = r.finish();
    assert.equal(s.status, Status.FAIL);
    assert.equal(s.exitCode, 1);
    assert.equal(s.findings[0].kind, FindingKind.VIOLATION);
  });

  test('findings win over a coverage shortfall, and the shortfall is still reported', () => {
    const r = new CheckReport('t', { maxSkipRatio: 0.5 });
    r.scanned('a'); r.finding('a', 'bad'); r.skipped('b', 'x'); r.skipped('c', 'y');
    const s = r.finish();
    assert.equal(s.status, Status.FAIL);
    assert.equal(s.exitCode, 1);
    assert.equal(s.coverage.sufficient, false);
    assert.match(s.coverage.reasons[0], /2 of 3 targets were skipped/);
    assert.match(formatReport(s), /\[FAIL\][\s\S]*coverage: 2 of 3 targets were skipped/);
  });

  test('skips above maxSkipRatio make the run INCONCLUSIVE', () => {
    const r = new CheckReport('t', { maxSkipRatio: 0.5 });
    r.scanned('a'); r.skipped('b', 'x'); r.skipped('c', 'y');
    const s = r.finish();
    assert.equal(s.status, Status.INCONCLUSIVE);
  });

  test('skips at or below the ratio are fine but stay in the report', () => {
    const r = new CheckReport('t', { maxSkipRatio: 0.5 });
    r.scanned('a'); r.skipped('b', 'migrating');
    const s = r.finish();
    assert.equal(s.status, Status.PASS);
    assert.deepEqual(s.skipped, [{ id: 'b', reason: 'migrating' }]);
    assert.match(formatReport(s), /skipped b: migrating/);
  });

  test('a skip without a reason is rejected', () => {
    const r = new CheckReport('t');
    assert.throws(() => r.skipped('a'), TypeError);
    assert.throws(() => r.skipped('a', '   '), TypeError);
  });

  test('an unverifiable finding counts as discovered but not scanned', () => {
    const r = new CheckReport('t');
    r.finding('a', 'cannot parse', { kind: FindingKind.UNVERIFIABLE });
    const s = r.finish();
    assert.equal(s.status, Status.FAIL);
    assert.equal(s.discovered, 1);
    assert.equal(s.scanned, 0);
    assert.match(s.coverage.reasons[0], /only 0 target\(s\)/);
  });

  test('a violation on a target that was never scanned is a programming error', () => {
    const r = new CheckReport('t');
    assert.throws(() => r.finding('ghost', 'bad'), /never scanned/);
    assert.throws(() => r.finding('a', 'x', { kind: 'weird' }), RangeError);
  });

  test('each target id is recorded exactly once', () => {
    const r = new CheckReport('t');
    r.scanned('a');
    assert.throws(() => r.scanned('a'), /already recorded/);
    assert.throws(() => r.skipped('a', 'x'), /already recorded/);
    assert.throws(() => r.finding('a', 'x', { kind: FindingKind.UNVERIFIABLE }), /already recorded/);
  });

  test('a source error is a coverage shortfall kept apart from "empty"', () => {
    const r = new CheckReport('t');
    r.sourceError('cannot read ./missing (ENOENT)');
    const s = r.finish();
    assert.equal(s.status, Status.INCONCLUSIVE);
    assert.deepEqual(s.coverage.reasons, ['target source unavailable: cannot read ./missing (ENOENT)', 'no targets were discovered']);
    assert.throws(() => r.sourceError(''), TypeError);
  });

  test('minTargets of 0 is rejected at construction', () => {
    assert.throws(() => new CheckReport('t', { minTargets: 0 }), RangeError);
  });

  test('exit codes are distinct per status', () => {
    assert.equal(new Set(Object.values(ExitCode)).size, 3);
  });
});

describe('CheckReport override (the approval boundary)', () => {
  test('override changes the exit code but the status stays INCONCLUSIVE and is recorded', () => {
    const s = new CheckReport('t').finish({ override: { by: 'alice', reason: 'new environment, no manifests yet' } });
    assert.equal(s.status, Status.INCONCLUSIVE);
    assert.equal(s.exitCode, 0);
    assert.deepEqual(s.override, { by: 'alice', reason: 'new environment, no manifests yet' });
    assert.match(formatReport(s), /OVERRIDE recorded, by "alice"/);
  });

  test('a run with findings cannot be overridden, even when coverage was also short', () => {
    const r = new CheckReport('t', { minTargets: 5 });
    r.scanned('a'); r.finding('a', 'bad');
    assert.throws(() => r.finish({ override: { by: 'alice', reason: 'partial rollout' } }), /this run is fail/);
  });

  test('override on a passing run is an error', () => {
    const r = new CheckReport('t');
    r.scanned('a');
    assert.throws(() => r.finish({ override: { by: 'alice', reason: 'x' } }), /this run is pass/);
  });

  test('override must carry who and why', () => {
    assert.throws(() => new CheckReport('t').finish({ override: { by: 'alice' } }), TypeError);
    assert.throws(() => new CheckReport('t').finish({ override: { reason: 'x' } }), TypeError);
    assert.throws(() => new CheckReport('t').finish({ override: { by: '', reason: 'x' } }), TypeError);
  });
});

describe('heartbeat', () => {
  const now = new Date('2026-01-02T12:00:00Z');

  test('a record is written only for a conclusive verdict', () => {
    assert.equal(heartbeatRecord({ job: 'j', verdict: 'pass', now }).verdict, 'pass');
    assert.equal(heartbeatRecord({ job: 'j', verdict: 'fail', now }).verdict, 'fail');
    assert.throws(() => heartbeatRecord({ job: 'j', verdict: 'inconclusive', now }), RangeError);
    assert.throws(() => heartbeatRecord({ job: 'j', now }), RangeError);
  });

  test('missing record is MISSING with exit 2, not fresh', () => {
    const a = assessHeartbeat(null, { maxAgeHours: 24, now });
    assert.equal(a.status, Heartbeat.MISSING);
    assert.equal(heartbeatExitCode(a), 2);
  });

  test('recent record is FRESH and names the verdict', () => {
    const rec = heartbeatRecord({ job: 'nightly', verdict: 'fail', now: new Date('2026-01-02T01:00:00Z') });
    const a = assessHeartbeat(rec, { maxAgeHours: 24, now });
    assert.equal(a.status, Heartbeat.FRESH);
    assert.equal(heartbeatExitCode(a), 0);
    assert.ok(Math.abs(a.ageHours - 11) < 1e-9);
    assert.match(a.reason, /verdict fail/);
  });

  test('old record is STALE', () => {
    const rec = heartbeatRecord({ job: 'nightly', verdict: 'pass', now: new Date('2025-12-31T00:00:00Z') });
    const a = assessHeartbeat(rec, { maxAgeHours: 24, now });
    assert.equal(a.status, Heartbeat.STALE);
    assert.match(a.reason, /60\.0h ago \(limit 24h\)/);
  });

  test('unreadable or future timestamps are INVALID, exit 2', () => {
    assert.equal(assessHeartbeat({ lastConclusiveRunAt: 'garbage' }, { maxAgeHours: 24, now }).status, Heartbeat.INVALID);
    const future = assessHeartbeat({ lastConclusiveRunAt: '2026-01-03T00:00:00Z' }, { maxAgeHours: 24, now });
    assert.equal(future.status, Heartbeat.INVALID);
    assert.equal(heartbeatExitCode(future), 2);
  });

  test('exactly at the limit is still FRESH; one second past is STALE', () => {
    const rec = { job: 'nightly', verdict: 'pass', lastConclusiveRunAt: '2026-01-01T12:00:00Z' };
    assert.equal(assessHeartbeat(rec, { maxAgeHours: 24, now }).status, Heartbeat.FRESH);
    assert.equal(assessHeartbeat(rec, { maxAgeHours: 24, now: new Date('2026-01-02T12:00:01Z') }).status, Heartbeat.STALE);
  });
});
