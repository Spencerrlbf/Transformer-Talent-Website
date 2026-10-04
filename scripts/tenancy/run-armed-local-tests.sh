#!/bin/bash
# Local PostgreSQL only: the leak test's armed-mode orchestration (scripts/tenancy/armed.mjs)
# on a fresh full chain. The HTTP probes need a deployment with Auth and REST and are
# run with `node scripts/test-tenancy.mjs --base <url> --armed` against a DISPOSABLE database.
set -euo pipefail
TRANSITION_SUITE=armed exec bash scripts/person-transition-cli/run-local-tests.sh "$@"
