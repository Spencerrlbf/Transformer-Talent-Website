# Certified refresh worker

With `PERSON_TRANSITION_SUPPORT=on` and `PERSON_WRITE_MODE=shadow|live`, the nightly
CLI uses certified queue selection, lifecycle admission and atomic refresh save.
The prepared SQL remains uninstalled until the approved release. Support-off
orchestration is unchanged; support-on legacy and precompute modes are refused
before network access. Paid derivative consumption remains deferred.

Selection returns at most 50 recoverable owners plus 500 pristine queue entries,
with cached work first and one entry per candidate. A cached pick is free-only even
if its cache expires before claim. Missing ownership history is explicit review;
terminal review/uncertain rows do not fill the actionable window. Held controllers
allow no worker mutation; draining permits recovery of existing work only.

A provider call requires the first committed start result. The CLI makes one HTTP
request with redirects refused. Database retries preserve their original identity
and payload. Unknown provider outcomes never repurchase. A late captured source can
admit one fresh free request; a failed profile save retains the source for a later
invocation. Historical completed results remain authoritative after response loss.

Top-up examines at most the first 20,000 engaged candidates and inserts at most
500 rows through one private database operation. It holds the controller lock,
checks eligibility again after candidate locks, locks selected candidates in UUID
order, and tolerates a confirmed concurrent fresh queue insertion. Suppressed or
altered writes still fail. No source payloads or credentials appear in worker logs.

Run the isolated local suite (PostgreSQL fixture only):

```
PSQL=/path/to/psql bash scripts/person-refresh-worker/run-local-tests.sh LOCAL_PORT
```

The runner resets only `person_refresh_worker_test` on loopback. Real SQL and the
actual CLI cover restart recovery, missing ownership, cache expiry, phase changes,
concurrent insertion and deadlocks. Provider traffic is synthetic and confined to
loopback. The save and lifecycle regression runners load this prepared migration.
