#!/bin/bash
set -euo pipefail
bash scripts/person-directory-input/run-local-tests.sh "${1:?local port required}"
node --test scripts/person-directory-admission/test-decision.mjs
