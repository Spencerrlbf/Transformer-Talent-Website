#!/bin/bash
# Pre-release protection of Storage objects: lists every bucket recursively, downloads and
# verifies each object (independent storage.objects inventory, sizes, eTag MD5 where plain,
# SHA256/MD5 manifest) into a private directory. Read-only against the project. See the header
# of scripts/person-release/export-storage-objects.mjs for the exact checks and the exit codes.
#
#   PERSON_TARGET_PROJECT_REF=<ref> SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
#   STORAGE_DATABASE_URL='<5432 session url>' bash scripts/person-release/export-storage-objects.sh <private output dir>
#   bash scripts/person-release/export-storage-objects.sh --verify <private output dir>
set -euo pipefail
node scripts/check-node.mjs >/dev/null
exec node scripts/person-release/export-storage-objects.mjs "$@"
