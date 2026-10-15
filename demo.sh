#!/usr/bin/env bash
# Walks through every scenario and prints the exit code after each one.
# Expected: pass -> 0, fail -> 1, inconclusive -> 2, override -> 0 but still labelled INCONCLUSIVE.
cd "$(dirname "$0")"
run() { echo; echo "\$ $*"; "$@"; echo "exit code: $?"; }

echo "== Example 1: manifest scan =="
run node examples/scan-manifests.js fixtures/manifests/clean
run node examples/scan-manifests.js fixtures/manifests/with-findings
run node examples/scan-manifests.js fixtures/manifests/empty
run node examples/scan-manifests.js fixtures/manifests/mostly-skipped
run node examples/scan-manifests.js fixtures/manifests/empty --override-by alice --override-reason "brand-new environment, no services deployed yet"

echo; echo "== Example 2: error-rate query =="
run node examples/error-rate.js fixtures/samples/healthy.json
run node examples/error-rate.js fixtures/samples/no_traffic.json
run node examples/error-rate.js fixtures/samples/gap.json
run node examples/error-rate.js fixtures/samples/spike.json

echo; echo "== Example 3: heartbeat =="
HB=$(mktemp -d)/nightly.json
run node examples/heartbeat.js check "$HB" --max-age-hours 24
run node examples/heartbeat.js touch "$HB" --job nightly-manifest-scan --run-id demo --verdict pass
run node examples/heartbeat.js check "$HB" --max-age-hours 24
