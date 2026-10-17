# Design, contracts and limits

[Overview](../README.md) · [한국어](design.ko.md)

## The problem

From the outside, three very different outcomes can look identical:

| What happened | What a findings-only report shows |
|---|---|
| The check ran and found nothing wrong | 0 findings |
| The check ran against zero targets (bad glob, empty query window, wrong path) | 0 findings |
| The check never ran, or was killed before reporting | nothing, which a report that only lists findings cannot distinguish from 0 |

The first outcome supports a pass only when the check also met its coverage requirement. This repository shows three guards that make the other two visible:

1. **A minimum coverage.** A run that fully scanned fewer targets than expected, or skipped too many, cannot pass on its own. It is *inconclusive*, with its own exit code.
2. **Skips that explain themselves.** A target can be skipped, but only with a reason, the reason stays in the report, and the skip counts against coverage.
3. **A heartbeat written only by runs that reached a verdict.** A separate watchdog treats a missing or old heartbeat as an alarm, not as silence.

## The three examples

| Script | Models | Input | Verdict | Exit |
|---|---|---|---|---|
| `examples/scan-manifests.js` | a nightly policy scan over service manifests | `fixtures/manifests/clean` | pass | 0 |
| | | `fixtures/manifests/with-findings` | fail: one legacy auth mode (violation), one file that does not parse (unverifiable) | 1 |
| | | `fixtures/manifests/empty` | **inconclusive: no targets were discovered** | 2 |
| | | a path that does not exist | **inconclusive: target source unavailable (ENOENT)**, plus no targets | 2 |
| | | `fixtures/manifests/mostly-skipped` | **inconclusive: 2 of 3 skipped**, both reasons listed | 2 |
| | | `empty` + `--override-by alice --override-reason "..."` | still labelled inconclusive, override recorded | 0 |
| | | `with-findings` + the same override flags | fail, `override refused: run is fail` | 1 |
| `examples/error-rate.js` | a per-bucket error-rate check, 12 five-minute buckets | `fixtures/samples/healthy.json` | pass | 0 |
| | | `fixtures/samples/no_traffic.json` (12 buckets, all zero requests) | **inconclusive: 0 of 12 buckets evaluable** | 2 |
| | | `fixtures/samples/gap.json` (only 5 buckets arrived) | **inconclusive: 5 < 11** | 2 |
| | | `fixtures/samples/spike.json` | fail, offending buckets named | 1 |
| `examples/heartbeat.js` | a job's last-verdict signal and its watchdog | no file yet | **missing** | 2 |
| | | `touch --verdict pass` or `fail`, then `check` within the limit | fresh | 0 |
| | | `touch` without a verdict | refused, no file written | 2 |
| | | record older than `--max-age-hours` | **stale** | 2 |

Output for the empty directory:

```
[INCONCLUSIVE] manifest policy: no legacy-token auth: scanned 0 of 0 discovered, skipped 0, findings 0 (0 violation, 0 unverifiable)
  coverage: no targets were discovered
exit code: 2
```

Both check examples accept `--json` and print the summary object instead, so a pipeline can read `status`, `coverage`, `findings[].kind` and `override` without parsing log text.

All three CLIs reject unknown or repeated options, missing values and extra positional arguments with exit 2. Heartbeat flags are specific to `touch` or `check`. Use `--` before a positional path that begins with `-`. A typo must not silently change the policy that actually runs.

## Design

The core is one class, `CheckReport` in [`src/guards.js`](../src/guards.js), plus a few pure heartbeat functions. The examples are thin wrappers around it.

### The result contract: found, covered, next

`CheckReport` tracks each target once for coverage. A target is recorded as scanned, skipped, or unverifiable, and the same id cannot be recorded twice in those roles. A violation finding is then attached to a target already marked as scanned. Source errors are recorded separately from targets.

| Call | Meaning |
|---|---|
| `scanned(id)` | the target was fully inspected |
| `skipped(id, reason)` | deliberately not inspected; the reason is mandatory |
| `finding(id, message)` | `kind: violation` (default): the already-scanned target breaks the policy. Throws if `id` was not scanned |
| `finding(id, message, { kind: 'unverifiable' })` | the target exists but could not be inspected; this records the target itself, so it is neither scanned nor skipped |
| `sourceError(message)` | the target source could not be read (missing directory, failed query). Kept apart from "readable and empty" because the two have different owners |

`finish()` then reports:

- **found**: the findings, with their kind
- **covered**: `scanned`, `discovered` (scanned + skipped + unverifiable) and `coverage.reasons`, which is empty when coverage was sufficient
- **next**: `status` and `exitCode`, and the `override` if one was recorded

### Verdicts

| Condition | Status | Exit |
|---|---|---|
| any finding, whatever the coverage | fail | 1 |
| no finding, and a coverage shortfall (source error, zero discovered, `scanned < minTargets`, or skip ratio above `maxSkipRatio`) | inconclusive | 2 |
| no finding, sufficient coverage | pass | 0 |

Findings win. A known violation is never hidden behind "but coverage was low"; the coverage shortfall is reported alongside it. A regression test ensures insufficient coverage cannot turn a finding into an inconclusive result.

`inconclusive` is deliberately not folded into `fail`. A failed scan and a scan that had nothing to scan need different responders: the first goes to whoever owns the violating target, the second to whoever owns the automation. The exit code alone does not perform that routing; it only makes it possible. A CI that treats every non-zero as "failed" will show both as red, and the `--json` output or the log line is what a router would read.

`minTargets` defaults to 1 and the constructor rejects 0. "I expect zero targets" is the override path below, not a configuration value. If an environment is *routinely* empty, overriding every run is the wrong tool; the right one is to compare an expected target set against the observed one, which this repository does not implement.

### Overrides and their trust boundary

Sometimes zero targets is correct, for example a brand-new environment with nothing deployed yet. `finish({ override: { by, reason } })` and the `--override-by / --override-reason` flags exist for that:

1. Both a name and a reason are required. Anonymous overrides are rejected.
2. An override is accepted only on an inconclusive run. A run with findings cannot be overridden; the CLI prints `override refused` and keeps exit 1.
3. The **status stays `inconclusive`** in the summary and in the log line. Only the exit code changes to 0, and the override is recorded alongside the coverage shortfall it waives.

What the override records is a **claim**: `by` is whatever string the caller supplied. The CI scenarios pass the pipeline's actor variable, which is as good as that pipeline's own authentication and no better. Verifying approval requires an external control that authenticates the approver and binds the approval to this run and this override. The guard's contribution is that the decision is written down next to the thing it waived.

### Heartbeat

`heartbeatRecord` is written as the **last** step of a job, and only when the run was classified `pass` or `fail`. It therefore records "the most recent run that reached a verdict", which includes failures with incomplete coverage; it does not mean "the check verified everything". Inconclusive runs do not refresh it, even when overridden, and neither does a crash. What the watchdog detects is the absence of a recent verdict: a job that is dead, and equally a job that is alive but has been inconclusive for longer than the limit. Both deserve a look.

`assessHeartbeat` is a pure function of the record and the current time, which is what makes the stale/fresh boundary testable to the second. A record from the future is `invalid`, not fresh.

The persisted record must contain a non-empty job name, a `pass` or `fail` verdict and a valid UTC timestamp (`YYYY-MM-DDTHH:mm:ss[.sss]Z`). A recent timestamp alone does not establish a conclusive run. Caller-supplied `now` must be a valid `Date`, and the age limit must be a finite positive number. These checks reject malformed data; they do not authenticate who wrote a record or bind it to an expected job.

`touch` writes and flushes a uniquely named staging file beside the destination, then replaces the record. A failed staging write or rename leaves the previous record intact; temporary files are cleaned up when possible. This avoids truncating the last valid heartbeat during an ordinary write failure. It is not a distributed lock or a promise of durability after power loss; concurrent writers remain last-replacement-wins, and filesystem behavior still matters.

The check scripts do not write the heartbeat themselves; `examples/heartbeat.js` is a separate CLI, and composing the two is the job runner's work. In a shell step it is four lines:

```bash
node examples/scan-manifests.js ./manifests; code=$?
case $code in
  0) node examples/heartbeat.js touch ./nightly.json --job nightly --verdict pass ;;
  1) node examples/heartbeat.js touch ./nightly.json --job nightly --verdict fail ;;
esac   # exit 2 writes nothing
exit $code
```

### Failure paths

| Situation | Behaviour | Why |
|---|---|---|
| Directory missing or unreadable | `sourceError`, inconclusive, exit 2 | different owner from "directory exists and is empty", so a different reason line |
| Directory exists, matches nothing | `no targets were discovered`, inconclusive, exit 2 | a glob that stopped matching |
| Manifest that does not parse or lacks a valid `auth.mode` / skip reason | `unverifiable` **finding**, fail | a target you cannot inspect is not clean; calling it a skip would lower coverage silently |
| Skip without a reason | `TypeError` at call time | silent skips are what the report exists to prevent |
| Same target id scanned, skipped or marked unverifiable twice | `Error` at call time | a source that returns a target twice is an upstream bug, not extra coverage |
| Violation reported on a target never scanned | `Error` at call time | you cannot judge what you did not inspect |
| Uncaught error before the verdict | exit 2 | an unfinished run is "not proven", never 0 |
| Process killed from outside | no exit code of ours | the gap the heartbeat exists for |
| Error-rate bucket with zero requests | skipped with reason | the error rate is undefined when there are no requests |
| Invalid sample shape, counts or numeric policy | throws; CLI exit 2 | malformed evidence must not silently become a zero-traffic skip or clean rate |
| Heartbeat file missing | `missing`, exit 2 | absence is not freshness |
| Heartbeat unreadable or in the future | `invalid`, exit 2 | clock skew and edited files should not look healthy |

### What the error-rate check is, precisely

A **per-bucket** threshold: any bucket above 1 % is a violation, so a short burst is not diluted by a quiet hour. It is not the hour's aggregate `sum(errors) / sum(requests)`. The example requires at least 11 evaluable buckets out of 12, so it tolerates one missing or empty bucket; a missing bucket could contain errors, and that tolerance is a chosen trade-off, not a guarantee. Duplicate bucket ids throw. Bucket timestamps are counted, not validated against the window.

Samples require non-empty string ids and safe integer counts with `0 <= errors <= requests`. Numeric strings, negative counts, non-finite values and fractional counts are rejected. Configuration also rejects numeric coercion. A syntactically valid JSON value is not automatically valid evidence.

## What the scenario script proves, and what it cannot

[`scripts/scenarios.mjs`](../scripts/scenarios.mjs) copies a fixture into a scratch directory and runs the real CLI while the input changes **between invocations**: present → deleted → recreated empty → overridden, then a refused override on findings, the no-traffic query, and a watchdog with no record. It asserts the exit code after every step, and where an exit code cannot show the guarantee it asserts the output (`[INCONCLUSIVE]` and `OVERRIDE recorded` after an override, `override refused` on findings) or the file state (no heartbeat file after a refused `touch`). The harness itself exits 0 when every expectation holds; a consuming pipeline that propagates the CLI's exit code is what would fail the step. It uses Node subprocess APIs directly and cleans up its own temporary directory, so the same contract can run on Windows and Unix.

What this cannot prove is anything about *your* pipeline: whether exit 2 reaches a different channel than exit 1, whether the `--json` output is stored, whether anyone reads the `OVERRIDE recorded` line. Those are integration properties of the system that adopts the guards. It also does not model an input changing while a single invocation is running.

## Related patterns

None of the three mechanisms is new. pytest distinguishes "tests failed" from "no tests were collected" with a separate exit code. Prometheus has `absent()` and `absent_over_time()` to alert on data that is not there. Dead-man's-switch services exist to page when a scheduled job stops checking in. What this repository adds is the three side by side in one small, runnable form, and a result contract that keeps "what was not proven" visible after a human waives it.

## Limits

- **Thresholds are illustrative.** `minTargets`, `maxSkipRatio`, the 1 % error rate and the 12 buckets are demo values. Real values come from measured traffic and the team's tolerance, and they need an owner: if a configured minimum is not updated when the target set shrinks, routine runs start to require overrides.
- **Coverage is counted, not named.** A minimum of 1 is satisfied by any one target, and a 50 % skip ratio lets one of two targets be skipped, including the one that matters most. A required-target list would be the next guard; it is not implemented here.
- **Bucket completeness is counted, not validated.** The error-rate check counts buckets and rejects duplicates; it does not verify that each bucket's timestamp falls inside the intended window.
- **Routing is not included.** Exit code 2 and the `--json` summary make an inconclusive run distinguishable. Sending it somewhere other than the "failed" channel is pipeline work.
- **The override is recorded, not authenticated.** See the trust boundary above.
- **The watchdog is itself a job.** It needs independent monitoring. Running it on a different host removes shared-host failures but does not detect the watchdog itself stopping. This repository stops at one level.

## What I'd test next

- **Required targets.** Remove a required service while keeping the total above `minTargets`; check that comparing expected and observed target ids exposes the omission where the count alone does not.
- **Bucket windows.** Supply twelve unique buckets with one outside the requested hour; check that the count alone satisfies the coverage requirement and that a window check is what catches it.
- **Agent-reported coverage.** Have an agent report "no issues" after receiving only part of the intended input; test whether an independent record of the inputs it was given exposes the gap. That record would establish input availability, not prove the model examined the inputs correctly.

## Layout

```
src/guards.js              CheckReport, formatReport, heartbeat helpers
examples/                  three runnable scripts, each exporting its core for tests; --json on the first two
fixtures/                  synthetic manifests and metric samples
test/                      node:test suites for the core and for each example's exit codes and output
scripts/scenarios.mjs     portable CLI contract while inputs change between invocations
scripts/demo.mjs          portable fixture walkthrough
.github/workflows/ci.yml   tests + scenarios on Node 22 and 24
demo.sh                    optional Bash wrapper for the Node demo
```

## License

MIT
