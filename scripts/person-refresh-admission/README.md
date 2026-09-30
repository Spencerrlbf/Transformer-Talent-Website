# Refresh admission entry guard

The existing refresh claim can reserve paid work before the transition and source
fences authorize its later persistence. Until the complete certified refresh
lifecycle is available, transition support `on` refuses the old CLI, normalized
orchestration, and direct refresh APIs before database/network effects. Invalid
support settings fail closed; unset/`off` retain the current implementation.

This is a prepared prerequisite, not a certified refresh writer. No schema, live
flags, provider calls or production deployment change here. Reservation, cache
ownership, late paid responses and atomic completion still require integration.

Run `node scripts/build-worker-lib.mjs`, then
`node --test scripts/person-refresh-admission/test-entry.mjs`.
The CLI cases preload a complete network denial. Direct cases reject before any
query/pool access. Compatibility is checked with
`PSQL=/path/to/psql bash scripts/person-refresh/run-local-tests.sh LOCAL_PORT`
against its caller-owned loopback fixture database.
