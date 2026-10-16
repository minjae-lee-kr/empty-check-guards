#!/usr/bin/env bash
# Backward-compatible convenience wrapper. No Bash is needed for the Node command.
exec node "$(dirname "$0")/scripts/demo.mjs"
