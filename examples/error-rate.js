#!/usr/bin/env node
// Example 2 — a monitoring query that returns zero.
//
// Synthetic scenario: a query sums errors over the last hour in twelve 5-minute buckets
// and alerts when any bucket's error rate exceeds 1%. "0 errors" is the hoped-for
// answer, but it is also exactly what you get when the metrics pipeline is down,
// when the service received no traffic, or when the query window is wrong.
//
// The guard: every bucket is a target. A bucket with zero requests is *skipped* with
// that reason (0/0 is not a rate), and the check expects a minimum number of buckets
// (expected minus one, tolerating a single late bucket). Missing buckets or too many
// empty ones make the verdict INCONCLUSIVE.
//
// What this check is: a per-bucket threshold check, so a short burst is not diluted by
// a quiet hour. What it is not: the hour's aggregate rate (sum errors / sum requests).
// A missing bucket could hold the errors, which is exactly why missing buckets are a
// coverage shortfall and not ignored.
//
// Usage:
//   node examples/error-rate.js <samples.json> [--expect-buckets 12] [--threshold 0.01] [--json]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CheckReport, formatReport } from '../src/guards.js';
import { parseArguments } from '../src/cli.js';

/**
 * @param {{bucket: string, requests: number, errors: number}[]} samples
 */
export function evaluateErrorRate(samples, { expectBuckets = 12, threshold = 0.01, maxSkipRatio = 0.5 } = {}) {
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
  if (!Number.isSafeInteger(expectBuckets) || expectBuckets < 1) {
    throw new RangeError('expectBuckets must be a safe integer >= 1');
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError('threshold must be a finite number in [0, 1]');
  }
  const minTargets = Math.max(1, expectBuckets - 1);
  const report = new CheckReport(`per-bucket error rate <= ${threshold * 100}% over ${expectBuckets} buckets`, { minTargets, maxSkipRatio });

  // Duplicate bucket ids throw inside the report; a query that returns the same bucket twice is a bug upstream.
  for (const s of samples) {
    if (!s || typeof s !== 'object' || Array.isArray(s)
        || typeof s.bucket !== 'string' || !s.bucket.trim()
        || !Number.isSafeInteger(s.requests) || s.requests < 0
        || !Number.isSafeInteger(s.errors) || s.errors < 0 || s.errors > s.requests) {
      throw new TypeError('each sample must have a non-empty bucket id and safe integer counts: 0 <= errors <= requests');
    }
    if (s.requests === 0) {
      report.skipped(s.bucket, 'zero requests in bucket; an error rate over no traffic is undefined');
      continue;
    }
    report.scanned(s.bucket);
    const rate = s.errors / s.requests;
    if (rate > threshold) {
      report.finding(s.bucket, `error rate ${(rate * 100).toFixed(2)}% (${s.errors}/${s.requests})`);
    }
  }

  return report.finish();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { options, positionals } = parseArguments(process.argv.slice(2), {
      values: ['--expect-buckets', '--threshold'], flags: ['--json'],
    });
    if (positionals.length !== 1) throw new Error('usage: error-rate.js <samples.json> [--expect-buckets N] [--threshold R] [--json]');
    const [file] = positionals;
    const opts = {
      ...(options['--expect-buckets'] !== undefined && { expectBuckets: Number(options['--expect-buckets']) }),
      ...(options['--threshold'] !== undefined && { threshold: Number(options['--threshold']) }),
    };
    const samples = JSON.parse(readFileSync(file, 'utf8'));
    const summary = evaluateErrorRate(samples, opts);
    console.log(options['--json'] ? JSON.stringify(summary, null, 2) : formatReport(summary));
    process.exitCode = summary.exitCode;
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 2;
  }
}
