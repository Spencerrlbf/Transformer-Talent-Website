#!/bin/bash
# Offline: explicit target selection, server gate and denied transports. No database.
set -euo pipefail
node scripts/check-node.mjs >/dev/null   # supported runtime first
node scripts/build-worker-lib.mjs
npx --yes esbuild@0.28.2 scripts/person-target/server-entry.ts --bundle --platform=node --format=esm --external:pg --alias:@="$PWD" --outfile=scripts/person-target/dist/server.mjs --log-level=warning
node --test scripts/person-target/test-target.mjs scripts/person-target/test-cli-targets.mjs scripts/person-target/test-server-target.mjs scripts/person-target/test-outbound-guard.mjs scripts/person-target/test-provider-denial.mjs scripts/person-target/test-check-node.mjs scripts/person-maintenance/test-run-catchup-inputs.mjs scripts/person-maintenance/test-contact-compat.mjs
