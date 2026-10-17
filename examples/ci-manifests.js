#!/usr/bin/env node
// Fixed integration example: run this repository's manifest CLI, validate this
// child's complete JSON result, then persist a conclusive-verdict heartbeat.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArguments } from '../src/cli.js';
import { touch } from './heartbeat.js';

const checker = fileURLToPath(new URL('./scan-manifests.js', import.meta.url));
const checkName = 'manifest policy: no legacy-token auth';
const job = 'manifest-policy';
const text = (value) => typeof value === 'string' && value.trim() !== '';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireCondition(condition, message) { if (!condition) throw new Error(message); }
function keys(value, required, optional = []) {
  requireCondition(object(value), 'Expected a report object.');
  requireCondition(required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key)), 'Unexpected report shape.');
}

// This is the protocol of one owned checker, not a parser for arbitrary tools.
function validateSummary(summary, status, { minTargets, override }) {
  keys(summary, ['name', 'status', 'exitCode', 'scanned', 'discovered', 'skipped', 'findings', 'coverage', 'thresholds'], ['override', 'overrideRefused']);
  requireCondition(summary.name === checkName, 'Unexpected check identity.');
  requireCondition(['pass', 'fail', 'inconclusive'].includes(summary.status), 'Unknown check verdict.');
  requireCondition(Number.isSafeInteger(summary.scanned) && summary.scanned >= 0
    && Number.isSafeInteger(summary.discovered) && summary.discovered >= 0, 'Invalid coverage counts.');
  requireCondition(Array.isArray(summary.skipped) && Array.isArray(summary.findings), 'Missing target evidence.');
  keys(summary.coverage, ['sufficient', 'reasons']);
  requireCondition(typeof summary.coverage.sufficient === 'boolean' && Array.isArray(summary.coverage.reasons)
    && summary.coverage.reasons.every(text)
    && summary.coverage.sufficient === (summary.coverage.reasons.length === 0), 'Inconsistent coverage verdict.');
  keys(summary.thresholds, ['minTargets', 'maxSkipRatio']);
  requireCondition(summary.thresholds.minTargets === minTargets && summary.thresholds.maxSkipRatio === 0.5, 'Unexpected coverage policy.');
  const ids = new Set();
  for (const skipped of summary.skipped) {
    keys(skipped, ['id', 'reason']);
    requireCondition(text(skipped.id) && text(skipped.reason) && !ids.has(skipped.id), 'Invalid or repeated skipped target.');
    ids.add(skipped.id);
  }
  let unverifiable = 0;
  let violations = 0;
  for (const finding of summary.findings) {
    keys(finding, ['id', 'kind', 'message']);
    requireCondition(text(finding.id) && text(finding.message) && !ids.has(finding.id)
      && ['violation', 'unverifiable'].includes(finding.kind), 'Invalid or repeated finding.');
    ids.add(finding.id);
    if (finding.kind === 'unverifiable') unverifiable++; else violations++;
  }
  requireCondition(summary.discovered === summary.scanned + summary.skipped.length + unverifiable
    && violations <= summary.scanned, 'Target counts disagree.');
  const knownCoverageGap = summary.discovered === 0 || summary.scanned < minTargets
    || (summary.scanned + summary.skipped.length > 0 && summary.skipped.length / (summary.scanned + summary.skipped.length) > 0.5);
  requireCondition(!knownCoverageGap || !summary.coverage.sufficient, 'A known coverage gap was hidden.');
  const expectedStatus = summary.findings.length ? 'fail' : summary.coverage.sufficient ? 'pass' : 'inconclusive';
  requireCondition(summary.status === expectedStatus, 'Report evidence and verdict disagree.');
  let expectedExit = { pass: 0, fail: 1, inconclusive: 2 }[summary.status];
  if (summary.status === 'inconclusive' && override) {
    keys(summary.override, ['by', 'reason']);
    requireCondition(summary.override.by === override.by && summary.override.reason === override.reason
      && summary.overrideRefused === undefined, 'Override does not match this invocation.');
    expectedExit = 0;
  } else {
    requireCondition(summary.override === undefined, 'Unexpected override.');
    const refused = override ? `run is ${summary.status}, only an inconclusive run can be overridden` : undefined;
    requireCondition(summary.overrideRefused === refused, 'Unexpected override refusal.');
  }
  requireCondition(summary.exitCode === expectedExit && status === expectedExit, 'Process status and report verdict disagree.');
  return summary;
}

/** No executable/shell/entry-point option: this runs only the adjacent owned CLI. */
export function runManifestCi(directory, heartbeatFile, { minTargets = 1, override } = {}) {
  requireCondition(text(directory) && text(heartbeatFile), 'Manifest directory and heartbeat file are required.');
  requireCondition(Number.isSafeInteger(minTargets) && minTargets >= 1, 'Minimum coverage must be an integer >= 1.');
  if (override !== undefined) {
    keys(override, ['by', 'reason']);
    requireCondition(text(override.by) && text(override.reason), 'Override actor and reason must be non-empty.');
  }
  const runId = randomUUID();
  const args = [checker, '--json', '--min', String(minTargets),
    ...(override ? ['--override-by', override.by, '--override-reason', override.reason] : []), '--', resolve(directory)];
  // Capture output from this child in memory. No previous report artifact is read.
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true,
    timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, shell: false });
  const processResult = { status: child.status, signal: child.signal, stderrPresent: Boolean(child.stderr) };
  const failure = (stage, message, check) => ({ exitCode: 2, runId, status: 'integration-error', stage, message,
    child: processResult, heartbeat: stage === 'heartbeat' ? 'unconfirmed' : 'unchanged', ...(check ? { check } : {}) });
  if (child.error || child.signal !== null || !Number.isInteger(child.status)) {
    return failure('process', 'Checker did not complete normally.');
  }
  // This fixed CLI writes conclusive reports only to stdout. Exit 1 can mean
  // either a policy failure or a crash after printing a valid fail report;
  // unexpected stderr must not refresh liveness in the latter case.
  if (child.stderr) return failure('process', 'Checker wrote unexpected stderr.');
  let summary;
  try {
    summary = validateSummary(JSON.parse(child.stdout), child.status, { minTargets, override });
  } catch (error) {
    // Do not print raw malformed stdout/stderr as executable CI annotation text.
    return failure('report', error instanceof SyntaxError ? 'Checker did not produce one complete JSON report.' : error.message);
  }
  if (summary.status === 'inconclusive') {
    return { exitCode: summary.exitCode, runId, status: 'checked', check: summary, child: processResult, heartbeat: 'unchanged' };
  }
  try { touch(heartbeatFile, { job, runId, verdict: summary.status }); }
  catch { return failure('heartbeat', 'The check completed, but its heartbeat could not be persisted.', summary); }
  return { exitCode: summary.exitCode, runId, status: 'checked', check: summary, child: processResult, heartbeat: 'written' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { options, positionals } = parseArguments(process.argv.slice(2), { values: ['--min', '--override-by', '--override-reason'] });
    if (positionals.length !== 2) throw new Error('usage: ci-manifests.js <manifest-dir> <heartbeat-file> [--min N] [--override-by WHO --override-reason WHY]');
    if (Object.hasOwn(options, '--override-by') !== Object.hasOwn(options, '--override-reason')) {
      throw new Error('--override-by and --override-reason must be given together');
    }
    const result = runManifestCi(positionals[0], positionals[1], {
      minTargets: options['--min'] === undefined ? 1 : Number(options['--min']),
      ...(options['--override-by'] === undefined ? {} : { override: { by: options['--override-by'], reason: options['--override-reason'] } }),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.log(JSON.stringify({ status: 'integration-error', stage: 'arguments', message: error.message, heartbeat: 'unchanged', exitCode: 2 }));
    process.exitCode = 2;
  }
}
