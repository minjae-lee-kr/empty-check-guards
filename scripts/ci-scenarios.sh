#!/usr/bin/env bash
# Backward-compatible convenience wrapper. The portable implementation is Node.
exec node "$(dirname "$0")/scenarios.mjs"
