# Empty Check Guards

[English](README.md) · [한국어](README.ko.md)

**“Nothing found” is not the same as “nothing checked.”**

A manifest scan reports zero violations. If its input directory was empty, that result says nothing about whether the manifests are clean. An error-rate query with no traffic and a job that never reaches a verdict also need separate handling.

These personal examples read fictional manifests and metric samples through real CLIs. `CheckReport` counts inspected and skipped inputs, collects findings and returns pass, fail or inconclusive. A separate heartbeat CLI checks for a missing or stale pass/fail record. The guards have no runtime dependencies.

## Try the counterexample

Node.js 22 or newer. No installation, credentials or external services.

```sh
node scripts/demo.mjs
node --test
node scripts/scenarios.mjs
```

The demo runs manifest and error-rate checks. The scenario harness adds changing inputs, overrides and heartbeat handling through the real CLIs; it checks output and persisted state as well as exit codes.

| Observation | Verdict | Exit | Decision |
| --- | --- | ---: | --- |
| Sufficient coverage, no findings | pass | 0 | Continue. |
| A known violation, even with poor coverage | fail | 1 | Report the violation and coverage gap. |
| No findings, but too little evidence | inconclusive | 2 | Restore coverage before claiming success. |
| Explicit override of an inconclusive result | **still inconclusive** | 0 | Record the actor claim, reason and waived gap. |

**An override changes whether execution may continue; it does not turn uncertainty into evidence.** Findings cannot be overridden.

The consuming pipeline must decide whether an inconclusive run stops the workflow or proceeds with a recorded override. Exit code 0 alone is not enough: JSON retains the original verdict.

## Three decisions to inspect

- **Count what was actually inspected.** Targets cannot be counted twice. Skips need reasons; unreadable or malformed targets do not quietly become clean results.
- **Preserve the last real verdict.** A heartbeat is refreshed only after pass or fail. An inconclusive run—even an overridden one—does not refresh it. Staging and replacement preserve the previous file on an ordinary write failure.
- **Reject ambiguous input.** Numeric coercion, malformed evidence and unknown or repeated CLI options cannot silently weaken the policy. JSON summaries retain the verdict independently of the exit code.

The core is [`CheckReport`](src/guards.js). [Design notes](docs/design.md) explain the examples, failure paths, heartbeat semantics and integration contract.

## What this does not establish

Coverage is counted, not compared against a required identity set. Metric bucket timestamps are not checked against an expected window. Overrides and heartbeat writers are not authenticated. Heartbeat replacement is not a distributed lock or a power-loss durability guarantee. A consuming pipeline must route inconclusive results and monitor the watchdog itself.

All examples, services, metrics and thresholds are synthetic personal work. No employer implementation or production impact is claimed.

[Published CI](https://github.com/minjae-lee-kr/empty-check-guards/actions/workflows/ci.yml) runs the configured Ubuntu/Windows and Node 22/24 matrix after a push. Its status applies to the published revision, not unpublished local changes. MIT licensed.
