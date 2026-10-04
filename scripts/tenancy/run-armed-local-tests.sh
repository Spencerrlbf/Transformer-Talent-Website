#!/bin/bash
# Local PostgreSQL only: the leak test's armed-mode orchestration (scripts/tenancy/armed.mjs)
# on a fresh full chain. The HTTP probes need a deployment with Auth and REST and are
# run with `node scripts/test-tenancy.mjs --base <url> --armed` against a DISPOSABLE database.
set -euo pipefail
node scripts/check-node.mjs >/dev/null   # supported runtime, before any fixture DDL
TRANSITION_SUITE=armed exec bash scripts/person-transition-cli/run-local-tests.sh "$@"
