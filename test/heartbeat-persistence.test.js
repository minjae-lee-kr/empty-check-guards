import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { touch, check } from '../examples/heartbeat.js';
import { CheckReport } from '../src/guards.js';

function scratch(t) {
  const parent = resolve(tmpdir());
  const directory = fs.mkdtempSync(join(parent, 'heartbeat-persistence-'));
  assert.equal(dirname(directory), parent);
  t.after(() => { assert.equal(dirname(directory), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}
const now = new Date('2026-01-02T12:00:00Z');

test('failed staging write preserves previous heartbeat and removes its temporary file', (t) => {
  const directory = scratch(t);
  const file = join(directory, 'heartbeat.json');
  touch(file, { job: 'synthetic', verdict: 'pass', now });
  const before = fs.readFileSync(file, 'utf8');
  const original = fs.writeFileSync;
  const injected = t.mock.method(fs, 'writeFileSync', (descriptor, data, ...options) => {
    assert.equal(typeof descriptor, 'number', 'new content must be staged in an exclusively opened file');
    original(descriptor, String(data).slice(0, 12), ...options);
    throw Object.assign(new Error('synthetic partial write'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  try { assert.throws(() => touch(file, { job: 'synthetic', verdict: 'fail', now }), { code: 'ENOSPC' }); }
  finally { injected.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['heartbeat.json']);
  assert.equal(check(file, { maxAgeHours: 24, now }).status, 'fresh');
});

test('failed rename preserves the previous heartbeat; a later successful replacement works', (t) => {
  const directory = scratch(t);
  const file = join(directory, 'heartbeat.json');
  touch(file, { job: 'synthetic', verdict: 'pass', now });
  const before = fs.readFileSync(file, 'utf8');
  const injected = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('synthetic rename refusal'), { code: 'EACCES' });
  });
  syncBuiltinESMExports();
  try { assert.throws(() => touch(file, { job: 'synthetic', verdict: 'fail', now }), { code: 'EACCES' }); }
  finally { injected.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['heartbeat.json']);
  touch(file, { job: 'synthetic', verdict: 'fail', now });
  assert.equal(check(file, { maxAgeHours: 24, now }).verdict, 'fail');
});

test('present JSON null is invalid evidence, distinct from a missing file', (t) => {
  const directory = scratch(t);
  const file = join(directory, 'heartbeat.json');
  assert.equal(check(file, { maxAgeHours: 24, now }).status, 'missing');
  fs.writeFileSync(file, 'null\n');
  assert.equal(check(file, { maxAgeHours: 24, now }).status, 'invalid');
});

test('every independent coverage shortfall remains visible', () => {
  const report = new CheckReport('synthetic check', { minTargets: 5, maxSkipRatio: 0.5 });
  report.scanned('one'); report.skipped('two', 'intentional'); report.skipped('three', 'intentional');
  const result = report.finish();
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.coverage.reasons.length, 2);
  assert.match(result.coverage.reasons[0], /minimum 5/);
  assert.match(result.coverage.reasons[1], /2 of 3 targets were skipped/);
});
