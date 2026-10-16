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

import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { heartbeatRecord, assessHeartbeat, heartbeatExitCode } from '../src/guards.js';
import { parseArguments } from '../src/cli.js';

export function readRecord(file) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record === null ? { _error: 'record contains JSON null' } : record;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { lastConclusiveRunAt: undefined, _error: err.message }; // present but unreadable -> INVALID
  }
}

export function touch(file, { job = 'unnamed-job', runId, verdict, now } = {}) {
  const record = heartbeatRecord({ job, runId, verdict, now });
  // Stage beside the destination so a failed write cannot truncate the previous record.
  // This is local replacement, not a distributed lock or a power-loss durability guarantee.
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, JSON.stringify(record, null, 2) + '\n');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) {
      try { unlinkSync(temporary); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
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
      process.exitCode = 0;
    } else {
      const a = check(file, { maxAgeHours: Number(options['--max-age-hours']) });
      console.log(`[${a.status.toUpperCase()}] ${a.reason}`);
      process.exitCode = heartbeatExitCode(a);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 2;
  }
}
