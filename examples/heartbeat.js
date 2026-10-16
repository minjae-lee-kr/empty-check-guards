#!/usr/bin/env node
// Example 3 — the job that never ran.
//
// Examples 1 and 2 protect a run that happens. They cannot protect against a run
// that does not happen: a scheduler that was paused, a cron entry lost in a migration,
// a worker that is killed before printing its summary. For that you need a signal that
// is produced only by a completed run, and a second, independent process that notices
// when the signal stops.
//
// The event recorded here is "a conclusive run finished" (verdict pass or fail), not
// "the check passed". A failing verdict still records a completed check. An inconclusive or
// overridden run writes nothing, because it proved nothing.
//
// Usage:
//   node examples/heartbeat.js touch <file> --verdict pass|fail [--job NAME] [--run-id ID]
//   node examples/heartbeat.js check <file> --max-age-hours H
//
// "touch" is what a job calls as its last step. "check" is what a watchdog calls, on
// its own schedule and ideally from a different system. A missing file is exit 2, same
// as a stale one: absence is not freshness.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { heartbeatRecord, assessHeartbeat, heartbeatExitCode } from '../src/guards.js';
import { parseArguments } from '../src/cli.js';

export function readRecord(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { lastConclusiveRunAt: undefined, _error: err.message }; // present but unreadable -> INVALID
  }
}

export function touch(file, { job = 'unnamed-job', runId, verdict, now } = {}) {
  const record = heartbeatRecord({ job, runId, verdict, now });
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function check(file, { maxAgeHours, now }) {
  return assessHeartbeat(readRecord(file), { maxAgeHours, now });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [cmd, ...rest] = process.argv.slice(2);
    if (cmd !== 'touch' && cmd !== 'check') throw new Error('command must be touch or check');
    const { options, positionals } = parseArguments(rest, { values: cmd === 'touch'
      ? ['--job', '--run-id', '--verdict'] : ['--max-age-hours'] });
    if (positionals.length !== 1) throw new Error('exactly one heartbeat file is required');
    const [file] = positionals;
    if (cmd === 'touch') {
      const opt = { job: options['--job'], runId: options['--run-id'], verdict: options['--verdict'] };
      const r = touch(file, opt);
      console.log(`heartbeat written: ${r.job} completed a ${r.verdict} run at ${r.lastConclusiveRunAt}`);
      process.exit(0);
    }
    if (cmd === 'check') {
      const a = check(file, { maxAgeHours: Number(options['--max-age-hours']) });
      console.log(`[${a.status.toUpperCase()}] ${a.reason}`);
      process.exit(heartbeatExitCode(a));
    }
    console.error('usage: heartbeat.js touch <file> --verdict pass|fail [--job NAME] | check <file> --max-age-hours H');
    process.exit(2);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}
