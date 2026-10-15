#!/usr/bin/env node
// Example 1 — a nightly "lint" over service manifests.
//
// Synthetic scenario: every service has a manifest.json; a policy says the legacy
// token auth mode must be gone. The check walks a directory, records each manifest it
// inspected, each one it skipped (with the reason written in the manifest), and each
// violation. The thing this example demonstrates is what happens when the directory
// is empty, missing, or mostly skipped: the run is INCONCLUSIVE (exit 2), not a quiet pass.
//
// Usage:
//   node examples/scan-manifests.js <dir> [--min N] [--json]
//                                   [--override-by WHO --override-reason WHY]
//
// --json prints the full summary object instead of the log lines, for a pipeline that
// wants status / coverage / findings / override without parsing text.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckReport, FindingKind, Status, formatReport } from '../src/guards.js';

const DEPRECATED_AUTH_MODE = 'legacy-token';

/** Pure core, reused by the tests. Returns the summary from CheckReport#finish. */
export function scanManifests(dir, { minTargets = 1, maxSkipRatio = 0.5, override } = {}) {
  const report = new CheckReport(`manifest policy: no ${DEPRECATED_AUTH_MODE} auth`, { minTargets, maxSkipRatio });

  let entries = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    // A directory that cannot be read yields zero targets, like an empty one, but it is a
    // different problem with a different owner, so it is recorded as a source error.
    report.sourceError(`cannot read ${dir} (${err.code ?? err.message})`);
  }

  for (const file of entries) {
    const id = file.replace(/\.json$/, '');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      // A target we cannot inspect is not clean, and it is not a skip either.
      report.finding(id, `unparseable manifest: ${err.message}`, { kind: FindingKind.UNVERIFIABLE });
      continue;
    }
    const skipReason = manifest?.checks?.skip;
    if (skipReason) {
      report.skipped(id, String(skipReason));
      continue;
    }
    report.scanned(id);
    if (manifest?.auth?.mode === DEPRECATED_AUTH_MODE) {
      report.finding(id, `auth.mode is "${DEPRECATED_AUTH_MODE}"`);
    }
  }

  const summary = report.finish();
  if (override && summary.status === Status.INCONCLUSIVE) return report.finish({ override });
  if (override) summary.overrideRefused = `run is ${summary.status}, only an inconclusive run can be overridden`;
  return summary;
}

function parseArgs(argv) {
  const args = { dir: undefined, minTargets: 1, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min') args.minTargets = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--override-by') args.overrideBy = argv[++i];
    else if (a === '--override-reason') args.overrideReason = argv[++i];
    else if (!args.dir) args.dir = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!args.dir) throw new Error('usage: scan-manifests.js <dir> [--min N] [--json] [--override-by WHO --override-reason WHY]');
  if ((args.overrideBy || args.overrideReason) && !(args.overrideBy && args.overrideReason)) {
    throw new Error('--override-by and --override-reason must be given together');
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const override = args.overrideBy ? { by: args.overrideBy, reason: args.overrideReason } : undefined;
    const summary = scanManifests(args.dir, { minTargets: args.minTargets, override });
    console.log(args.json ? JSON.stringify(summary, null, 2) : formatReport(summary));
    process.exit(summary.exitCode);
  } catch (err) {
    // An uncaught error before the verdict is "not proven", never 0. (A process that is killed
    // from outside has no exit code of ours at all; that gap is what the heartbeat example covers.)
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}
