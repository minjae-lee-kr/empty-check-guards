// Guards that turn "nothing happened" into an explicit signal.
//
// From the outside, three very different outcomes look the same:
//
//   1. the check ran and found nothing wrong            -> genuinely fine
//   2. the check ran against zero (or too few) targets  -> a broken glob, an empty
//      query window, a misconfigured path
//   3. the check never ran or never reported            -> a dead scheduler, a crash
//      before the summary line
//
// Only the first one supports a clean verdict within the check's scope. This module makes (2) and (3) distinguishable
// from (1) by separating three things a check result usually blurs together:
//
//   - what was FOUND      (findings: policy violations, or targets that could not be inspected)
//   - what was COVERED    (how many targets were actually scanned vs skipped vs expected)
//   - what happens NEXT   (exit code, possibly changed by an explicit, recorded override)
//
// Findings always win: a known violation is never hidden behind "but coverage was low".
// Coverage shortfalls are always reported, even on a failing run.
// Only a run with no findings and insufficient coverage is INCONCLUSIVE, and only that
// state can be overridden.

export const Status = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  /** No findings, but the run cannot prove it looked at enough. Never exit 0 without an explicit override. */
  INCONCLUSIVE: 'inconclusive',
});

/** Process exit codes. INCONCLUSIVE is deliberately distinct from FAIL so a pipeline can route it differently. */
export const ExitCode = Object.freeze({
  [Status.PASS]: 0,
  [Status.FAIL]: 1,
  [Status.INCONCLUSIVE]: 2,
});

export const FindingKind = Object.freeze({
  /** The target was inspected and breaks the policy. Goes to whoever owns the target. */
  VIOLATION: 'violation',
  /** The target exists but could not be inspected (unparseable, unreadable). Goes to whoever owns the input. */
  UNVERIFIABLE: 'unverifiable',
});

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
  return value;
}

/**
 * Collects what a check looked at, what it skipped (and why), what it found, and whether the
 * target source itself was reachable, then produces a verdict that cannot be "pass" by accident.
 *
 * Each target id may be recorded exactly once, as scanned, skipped, or unverifiable.
 */
export class CheckReport {
  #name;
  #minTargets;
  #maxSkipRatio;
  #ids = new Set();
  #scanned = [];
  #skipped = [];
  #findings = [];
  #sourceErrors = [];

  /**
   * @param {string} name  Human-readable check name.
   * @param {object} [options]
   * @param {number} [options.minTargets=1]     Fewer fully scanned targets than this is a coverage shortfall.
   * @param {number} [options.maxSkipRatio=0.5] skipped / (scanned + skipped) above this is a coverage shortfall.
   */
  constructor(name, { minTargets = 1, maxSkipRatio = 0.5 } = {}) {
    requireText(name, 'name');
    if (!Number.isSafeInteger(minTargets) || minTargets < 1) {
      throw new RangeError('minTargets must be an integer >= 1; a check that accepts zero targets cannot distinguish "clean" from "not scanned"');
    }
    if (!Number.isFinite(maxSkipRatio) || !(maxSkipRatio >= 0 && maxSkipRatio < 1)) {
      throw new RangeError('maxSkipRatio must be in [0, 1)');
    }
    this.#name = name;
    this.#minTargets = minTargets;
    this.#maxSkipRatio = maxSkipRatio;
  }

  #claim(id) {
    const key = requireText(id, 'target id');
    if (this.#ids.has(key)) {
      throw new Error(`target ${JSON.stringify(key)} was already recorded; each target is scanned, skipped or unverifiable exactly once`);
    }
    this.#ids.add(key);
    return key;
  }

  /** Record a target that was fully inspected. */
  scanned(id) {
    this.#scanned.push(this.#claim(id));
  }

  /** Record a target that was deliberately not inspected. A reason is mandatory. */
  skipped(id, reason) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new TypeError(`skipped(${JSON.stringify(id)}) needs a non-empty reason; silent skips are what this report exists to prevent`);
    }
    this.#skipped.push({ id: this.#claim(id), reason });
  }

  /**
   * Record a problem. Any finding makes the verdict FAIL.
   *
   * @param {string} id
   * @param {string} message
   * @param {object} [options]
   * @param {'violation'|'unverifiable'} [options.kind='violation']
   *   A violation must be on a target already recorded as scanned (you cannot judge what you did
   *   not inspect). An unverifiable finding claims the id itself: the target was discovered but
   *   could not be inspected, so it is neither scanned nor skipped.
   */
  finding(id, message, { kind = FindingKind.VIOLATION } = {}) {
    const key = requireText(id, 'target id');
    requireText(message, 'finding message');
    if (kind === FindingKind.VIOLATION) {
      if (!this.#scanned.includes(key)) {
        throw new Error(`violation on ${JSON.stringify(key)} but it was never scanned; call scanned(id) first`);
      }
    } else if (kind === FindingKind.UNVERIFIABLE) {
      this.#claim(key);
    } else {
      throw new RangeError(`unknown finding kind ${JSON.stringify(kind)}`);
    }
    this.#findings.push({ id: key, kind, message });
  }

  /**
   * Record that the target source itself could not be read (missing directory, failed query,
   * permission error). This is always a coverage shortfall and is kept apart from "the source
   * was readable and empty", because the two have different owners.
   */
  sourceError(message) {
    if (typeof message !== 'string' || message.trim() === '') throw new TypeError('sourceError needs a message');
    this.#sourceErrors.push(message);
  }

  /**
   * Compute the verdict.
   *
   * @param {object} [options]
   * @param {{by: string, reason: string}} [options.override]
   *   An explicit, recorded decision to let an INCONCLUSIVE run proceed. The status stays
   *   INCONCLUSIVE in the summary; only the exit code changes to 0, and the override is written
   *   next to it. `by` is whatever the caller supplies (for example the CI actor variable): it is
   *   a recorded claim, not an authenticated approval. Rejected on PASS and FAIL runs.
   */
  finish({ override } = {}) {
    const scanned = this.#scanned.length;
    const skipped = this.#skipped.length;
    const unverifiable = this.#findings.filter((f) => f.kind === FindingKind.UNVERIFIABLE).length;
    const discovered = scanned + skipped + unverifiable;

    const coverageReasons = this.#sourceErrors.map((m) => `target source unavailable: ${m}`);
    if (discovered === 0) {
      coverageReasons.push('no targets were discovered');
    } else if (scanned < this.#minTargets) {
      coverageReasons.push(`only ${scanned} target(s) were fully scanned (minimum ${this.#minTargets})`);
    } else if (skipped / (scanned + skipped) > this.#maxSkipRatio) {
      coverageReasons.push(`${skipped} of ${scanned + skipped} targets were skipped (limit ${Math.round(this.#maxSkipRatio * 100)}%)`);
    }

    let status;
    if (this.#findings.length > 0) status = Status.FAIL;
    else if (coverageReasons.length > 0) status = Status.INCONCLUSIVE;
    else status = Status.PASS;

    const summary = {
      name: this.#name,
      status,
      exitCode: ExitCode[status],
      scanned,
      discovered,
      skipped: this.#skipped.map((entry) => ({ ...entry })),
      findings: this.#findings.map((entry) => ({ ...entry })),
      coverage: { sufficient: coverageReasons.length === 0, reasons: coverageReasons },
      thresholds: { minTargets: this.#minTargets, maxSkipRatio: this.#maxSkipRatio },
    };

    if (override !== undefined) {
      if (status !== Status.INCONCLUSIVE) {
        throw new Error(`override is only accepted for an ${Status.INCONCLUSIVE} run; this run is ${status}`);
      }
      for (const key of ['by', 'reason']) {
        if (typeof override[key] !== 'string' || override[key].trim() === '') {
          throw new TypeError(`override.${key} must be a non-empty string so the decision is recorded`);
        }
      }
      summary.override = { by: override.by, reason: override.reason };
      summary.exitCode = ExitCode[Status.PASS];
    }

    return summary;
  }
}

/** Render a summary for logs. Coverage shortfalls and skips are always listed, whatever the status. */
export function formatReport(summary) {
  const violations = summary.findings.filter((f) => f.kind === FindingKind.VIOLATION).length;
  const unverifiable = summary.findings.length - violations;
  const lines = [];
  lines.push(`[${summary.status.toUpperCase()}] ${summary.name}: scanned ${summary.scanned} of ${summary.discovered} discovered, skipped ${summary.skipped.length}, findings ${summary.findings.length} (${violations} violation, ${unverifiable} unverifiable)`);
  for (const r of summary.coverage.reasons) lines.push(`  coverage: ${r}`);
  for (const s of summary.skipped) lines.push(`  skipped ${s.id}: ${s.reason}`);
  for (const f of summary.findings) lines.push(`  ${f.kind} ${f.id}: ${f.message}`);
  if (summary.override) {
    lines.push(`  OVERRIDE recorded, by "${summary.override.by}": ${summary.override.reason} (exit code ${summary.exitCode}; status unchanged)`);
  }
  if (summary.overrideRefused) {
    lines.push(`  override refused: ${summary.overrideRefused}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Heartbeat: "this job last completed a conclusive run at T".
// Missing is an alarm, not silence.
// ---------------------------------------------------------------------------

export const Heartbeat = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  MISSING: 'missing',
  INVALID: 'invalid',
});

/**
 * Build the record a job persists after a *conclusive* run, as its last step.
 *
 * The event a heartbeat records is "the check ran to completion and reached a verdict", not
 * "the check passed": a FAIL verdict still records a completed check, and the watchdog is there to
 * notice the job going silent, not the policy being broken. INCONCLUSIVE runs, overridden runs
 * and crashes do not write one, because nothing was proven and the job must not look alive on
 * their account.
 */
export function heartbeatRecord({ job, runId, verdict, now = new Date() }) {
  requireText(job, 'job');
  if (runId != null) requireText(runId, 'runId');
  requireDate(now, 'now');
  if (verdict !== Status.PASS && verdict !== Status.FAIL) {
    throw new RangeError(`heartbeat records a conclusive run; verdict must be "${Status.PASS}" or "${Status.FAIL}", got ${JSON.stringify(verdict)}`);
  }
  return { job, runId: runId ?? null, verdict, lastConclusiveRunAt: now.toISOString() };
}

/**
 * Judge a persisted heartbeat record.
 *
 * @param {object|null|undefined} record  Parsed record, or null/undefined when no record exists.
 * @param {object} options
 * @param {number} options.maxAgeHours  Older than this -> STALE.
 * @param {Date}   [options.now]
 */
export function assessHeartbeat(record, { maxAgeHours, now = new Date() }) {
  if (!Number.isFinite(maxAgeHours) || !(maxAgeHours > 0)) throw new RangeError('maxAgeHours must be a finite number > 0');
  requireDate(now, 'now');
  const base = { ageHours: null, lastConclusiveRunAt: null, verdict: record?.verdict ?? null, limitHours: maxAgeHours };
  if (record == null) {
    return { ...base, status: Heartbeat.MISSING,
      reason: 'no heartbeat record exists; the job has never completed a run, or the record was lost' };
  }
  if (typeof record !== 'object' || Array.isArray(record)
      || typeof record.job !== 'string' || !record.job.trim()
      || (record.runId != null && (typeof record.runId !== 'string' || !record.runId.trim()))
      || (record.verdict !== Status.PASS && record.verdict !== Status.FAIL)
      || typeof record.lastConclusiveRunAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(record.lastConclusiveRunAt)) {
    return { ...base, status: Heartbeat.INVALID,
      reason: 'heartbeat record must identify a job, conclusive verdict and UTC timestamp; treat like missing' };
  }
  const last = new Date(record.lastConclusiveRunAt);
  const canonicalTimestamp = record.lastConclusiveRunAt.includes('.')
    ? record.lastConclusiveRunAt : record.lastConclusiveRunAt.replace(/Z$/, '.000Z');
  if (Number.isNaN(last.getTime())
      || last.toISOString() !== canonicalTimestamp) {
    return { ...base, status: Heartbeat.INVALID, lastConclusiveRunAt: record.lastConclusiveRunAt ?? null,
      reason: 'heartbeat record is unreadable; treat like missing' };
  }
  const ageHours = (now.getTime() - last.getTime()) / 3_600_000;
  if (ageHours < 0) {
    return { ...base, status: Heartbeat.INVALID, ageHours, lastConclusiveRunAt: last.toISOString(),
      reason: 'heartbeat is in the future; clock skew or an edited record' };
  }
  const status = ageHours > maxAgeHours ? Heartbeat.STALE : Heartbeat.FRESH;
  return {
    ...base,
    status,
    ageHours,
    lastConclusiveRunAt: last.toISOString(),
    reason: status === Heartbeat.STALE
      ? `last conclusive run was ${ageHours.toFixed(1)}h ago (limit ${maxAgeHours}h)`
      : `last conclusive run was ${ageHours.toFixed(1)}h ago, verdict ${record.verdict ?? 'unknown'}`,
  };
}

/** Exit code for a heartbeat assessment: only FRESH is 0. */
export function heartbeatExitCode(assessment) {
  return assessment.status === Heartbeat.FRESH ? 0 : 2;
}
