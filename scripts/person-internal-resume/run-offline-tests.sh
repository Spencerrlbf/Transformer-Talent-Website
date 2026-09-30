#!/bin/bash
set -euo pipefail
npx --yes esbuild@0.28.2 scripts/person-internal-resume/entry.ts --bundle --platform=node --format=esm --alias:@="$PWD" --alias:@/lib/server/supabase=./scripts/person-internal-resume/supabase-fixture.ts --alias:next/server=./scripts/person-application-queue/next-fixture.ts --outfile=scripts/person-internal-resume/dist/access.mjs --log-level=warning
node --test scripts/person-internal-resume/test-access.mjs
