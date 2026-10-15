#!/usr/bin/env bash
# Integration scenarios: the input environment changes between CLI invocations, and each
# invocation must return the exit code (and, where it matters, the output) a pipeline would act on.
#
# The unit tests prove what the functions return. This script proves the CLI contract: it copies a
# fixture into a scratch directory, runs the real CLI against it, then deletes the directory,
# recreates it empty, and overrides it, asserting after every step. A pipeline that propagates
# these exit codes would fail the step on 1 and 2.
#
# This harness itself exits 0 when every expectation holds (an expected exit 2 is a passing
# scenario here), and 1 on any mismatch.
set -u
cd "$(dirname "$0")/.."

fail=0
LAST_OUT=""
expect() {
  local want=$1; shift
  LAST_OUT=$("$@" 2>&1)
  local got=$?
  if [ "$got" -eq "$want" ]; then
    echo "ok   exit $got  $*"
  else
    echo "FAIL exit $got (expected $want)  $*"
    fail=1
  fi
}
# Assert on the previous command's output, for guarantees an exit code alone cannot show.
expect_out() {
  if printf '%s' "$LAST_OUT" | grep -qE "$1"; then
    echo "ok   output matches /$1/"
  else
    echo "FAIL output does not match /$1/"; printf '%s\n' "$LAST_OUT" | sed 's/^/     | /'
    fail=1
  fi
}
expect_absent() {
  if [ ! -e "$1" ]; then echo "ok   no file at $(basename "$1")"; else echo "FAIL file exists: $1"; fail=1; fi
}

WORK=$(mktemp -d)
ACTOR="${GITHUB_ACTOR:-local-user}"   # whoever the CI says is running this; a recorded claim, not an authentication

echo "# 1. manifests present and clean -> pass"
cp -R fixtures/manifests/clean "$WORK/manifests"
expect 0 node examples/scan-manifests.js "$WORK/manifests"

echo "# 2. the directory disappears (rename, bad checkout, wrong working dir) -> inconclusive, job blocked"
rm -rf "$WORK/manifests"
expect 2 node examples/scan-manifests.js "$WORK/manifests"

echo "# 3. the directory exists but matches nothing -> inconclusive, job blocked"
mkdir "$WORK/manifests"
expect 2 node examples/scan-manifests.js "$WORK/manifests"

echo "# 4. a recorded override lets the job proceed; the report still says INCONCLUSIVE and names the override"
expect 0 node examples/scan-manifests.js "$WORK/manifests" --override-by "$ACTOR" --override-reason "ci scenario: environment intentionally empty"
expect_out '^\[INCONCLUSIVE\]'
expect_out "OVERRIDE recorded, by \"$ACTOR\""

echo "# 5. a finding cannot be overridden"
expect 1 node examples/scan-manifests.js fixtures/manifests/with-findings --override-by "$ACTOR" --override-reason "please"
expect_out 'override refused: run is fail'

echo "# 6. error-rate: no traffic is not zero errors"
expect 2 node examples/error-rate.js fixtures/samples/no_traffic.json
expect 0 node examples/error-rate.js fixtures/samples/healthy.json

echo "# 7. heartbeat: a watchdog with no record alarms; a conclusive run silences it; a missing verdict is refused"
HB="$WORK/nightly.json"
expect 2 node examples/heartbeat.js check "$HB" --max-age-hours 24
expect 2 node examples/heartbeat.js touch "$HB" --job nightly
expect_absent "$HB"
expect 0 node examples/heartbeat.js touch "$HB" --job nightly --verdict fail
expect 0 node examples/heartbeat.js check "$HB" --max-age-hours 24

rm -rf "$WORK"
if [ "$fail" -ne 0 ]; then echo "scenario mismatch"; exit 1; fi
echo "all scenarios behaved as expected"
