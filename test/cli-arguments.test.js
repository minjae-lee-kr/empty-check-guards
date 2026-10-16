import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArguments } from '../src/cli.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function refused(script, args, pattern) {
  const result = spawnSync(process.execPath, [join(root, 'examples', script), ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2, `${args}: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stdout, /\[PASS\]|heartbeat written|\[FRESH\]/);
}

test('strict parser supports explicit option terminator without swallowing a flag value', () => {
  const parsed = parseArguments(['--count', '-1', '--json', '--', '--file.json'], {
    values: ['--count'], flags: ['--json'],
  });
  assert.equal(parsed.options['--count'], '-1');
  assert.equal(parsed.options['--json'], true);
  assert.deepEqual(parsed.positionals, ['--file.json']);
  for (const args of [['--count'], ['--count', '--json'], ['--count', ''], ['--count', '  ']]) {
    assert.throws(() => parseArguments(args, { values: ['--count'], flags: ['--json'] }), /requires a value/);
  }
});

test('monitoring CLI refuses typo, duplicate, incomplete and extra arguments', () => {
  const goodInput = 'fixtures/samples/healthy.json';
  for (const [args, message] of [
    [['--threshhold', '0'], /unknown option/],
    [['--threshold'], /requires a value/],
    [['--threshold', '--json'], /requires a value/],
    [['--threshold', '0.01', '--threshold', '1'], /duplicate option/],
    [['--json', '--json'], /duplicate option/],
    [['--threshold', 'NaN'], /finite number/],
    [['--expect-buckets', 'Infinity'], /safe integer/],
    [['unexpected.json'], /usage:/],
  ]) refused('error-rate.js', [goodInput, ...args], message);
});

test('manifest CLI refuses misspelled and incomplete override options', () => {
  const goodInput = 'fixtures/manifests/clean';
  for (const [args, message] of [
    [['--minimum', '1'], /unknown option/],
    [['--min'], /requires a value/],
    [['--min', '1', '--min', '2'], /duplicate option/],
    [['--override-by', '--override-reason', 'because'], /requires a value/],
    [['--override-by', 'reviewer', '--override-reason', ''], /requires a value/],
    [['--override-by', 'reviewer'], /must be given together/],
  ]) refused('scan-manifests.js', [goodInput, ...args], message);
});

test('heartbeat rejects wrong-command flags before creating a file', () => {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'heartbeat-args-'));
  assert.equal(dirname(directory), temporaryRoot);
  const file = join(directory, 'heartbeat.json');
  try {
    for (const [args, message] of [
      [['touch', file, '--verdict', 'pass', '--max-age-hours', '24'], /unknown option/],
      [['touch', file, '--verdict', 'pass', '--verdict', 'fail'], /duplicate option/],
      [['touch', file, '--verdict', 'pass', '--job', '--run-id', 'run'], /requires a value/],
      [['touch', file, '--verdict', 'pass', '--run-id', ''], /requires a value/],
      [['check', file, '--verdict', 'pass'], /unknown option/],
      [['check', file, '--max-age-hours', 'Infinity'], /finite number/],
      [['check', file, '--max-age-hours'], /requires a value/],
    ]) {
      refused('heartbeat.js', args, message);
      assert.equal(existsSync(file), false, 'refused arguments must not write a heartbeat');
    }
  } finally {
    assert.equal(dirname(directory), temporaryRoot);
    rmSync(directory, { recursive: true, force: true });
  }
});
