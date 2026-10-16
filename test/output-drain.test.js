import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI verdicts drain buffered output before natural process termination', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const parent = resolve(tmpdir());
  const directory = mkdtempSync(join(parent, 'guard-output-'));
  assert.equal(dirname(directory), parent);
  try {
    const preload = join(directory, 'buffer-output.cjs');
    // A deterministic asynchronous-output fixture, not a claim about host pipe timing.
    writeFileSync(preload, `for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      stream.write = (...args) => { setTimeout(() => write(...args), 25); return true; };
    }`);
    for (const [script, args, status, pattern] of [
      ['scan-manifests.js', ['fixtures/manifests/clean'], 0, /\[PASS\]/],
      ['error-rate.js', ['fixtures/samples/spike.json'], 1, /\[FAIL\]/],
      ['heartbeat.js', ['check', join(directory, 'missing.json'), '--max-age-hours', '24'], 2, /\[MISSING\]/],
    ]) {
      const result = spawnSync(process.execPath, ['--require', preload, join(root, 'examples', script), ...args], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr);
      assert.match(result.stdout, pattern);
    }
  } finally { assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true }); }
});
