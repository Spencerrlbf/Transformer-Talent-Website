# Atomic application admission preparation

Prepared database primitives only. No public form, callback or queue worker uses
this RPC yet. No production migration or activation is implied by this child.

`person_application_work_claim` proves the stored application's organization and
derives TT/tenant controller scope. It binds one durable work record to a first
input snapshot, one SHA-256 input hash and one existing `review:<org>` allowance
event. Work, snapshot and allowance commit together. A denied allowance rolls back
the provisional work, leaving the accepted application queued. Current allowance
events count in the same sliding 24-hour window; there is no second counter.

Concurrent first claims use the same work key. Only the owning token receives the
snapshot. Retries replay the retained inputs even if live output/preference fields
change; an optional expected input hash detects the wrong retained intent. Other
status results carrying a work ID must also prove its matching owned application
reservation. A generic transition claim alone is not evidence of application work.

TT lock order is shared72005/controller, work, organization allowance72013, then
application row. Ownership and first inputs are checked again after the row lock.
The RPC requires READ COMMITTED. Tenant work continues independently of TT held.
Lease expiry and uncertain execution stay unresolved and never spend again.

The snapshot includes the accepted stored role IDs, source, recruiter attribution,
preferences and resume path/hash. It does not contain resume bytes or resume text.
A nonempty resume path without `person_resume_sha256`, or a hash without a path,
returns `input_review` before reserving work or allowance. Legacy queued files
therefore require explicit verification before the new processing path may use
them. A stored hash must also be checked against callback/downloaded bytes by the
later processing integration; the SQL hash is not proof of a remote file's content.

The current stored fields reproduce existing queue semantics. Original apply
callbacks also receive raw requested role IDs and an explicit speculative flag.
The next integration must deliberately canonicalize both entrypoints from stored
accepted intent or persist those additional semantics before claiming. Do not
claim that this snapshot already preserves every original callback argument.

## Gates that remain before processing activation

- Public routes must durably store queued input and supplied resume bytes/hash
  before acceptance, with immutable future-interest preference intents.
- Callback and queue must share the claim before downloads, paid work or writes;
  `fromQueue` cannot bypass allowance. Verify retained resume bytes against hash.
- Existing unlocked `takeReview()` writers can still race this counter. A strict
  system-wide cap is not established until they are replaced or fully drained.
- Define safe pre-effects retry/release separately from interrupted provider work.
  Current parsing/vector/Airtable work has incomplete durable step evidence, so
  automatic whole-pipeline replay would be unsafe after effects begin.
- Complete only after all required writes, not merely an intake receipt or a
  `status=processed` patch. Recovery selection must include work state.
- Preserve existing best-effort acceptance notifications independently from paid
  processing. Queue recovery must not automatically resend them. Tests intercept
  all providers/messages; the migration itself sends none.
- Finish source fences, explicit legacy queue policy, runtime maintenance and
  canary/drain coverage; obtain Spencer's release approval before activation.

Run `PSQL=/path/to/psql bash scripts/person-application-work/run-local-tests.sh PORT`.
Only loopback `person_application_work_test` is reset. The real database tests
cover concurrency, allowance limits, immutable replay, partial transaction rollback,
old snapshots, owner/input races, review holds and SQL permissions.
