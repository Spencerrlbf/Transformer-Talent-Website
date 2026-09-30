# Network Send into the TT pipeline

With `PERSON_TRANSITION_SUPPORT=on`, a Network Send to Transformer Talent's own
role uses `person_network_send(row, mode)` from prepared migration
`20260928070000_person_network_send.sql`. Client-target Sends keep their existing
organization-scoped path.

The checked function holds the transition, username and candidate writer locks.
It refuses draining/held phases, validates the pool identity/profile, and decides
duplicates atomically. It recomputes the same effective email/phone as the caller:
eligible ranked contacts for published live people; existing contact and complete
verification-table reads for unpublished/legacy people. Tied legacy addresses
have a deterministic order. A changed contact snapshot returns a retryable refusal
without inserting a row. Verification-read failures cannot silently send blanks.

The pipeline row retains source `transformer_talent`, status `processed`, the
pool profile/contact and TT verdict. It is a pipeline entry, not a new person
source. An immutable private witness binds the full original inserted row, its
hash and the exact captured INSERT event ID/transaction/hash. The function checks
both the application row and the complete stored witness before reporting success.
Suppressed or altered proof rolls back the Send.

The audit snapshot includes that original insertion event even if it predates the
anchor. The independent auditor checks the witness and original payload, rather
than requiring the current application row to remain unchanged. Later checked
resume uploads and linked contact fills therefore retain a verified audit.
Missing or changed insertion proof never exempts the row from source accounting.

Name, LinkedIn identity, title, company and location match the pool record. The
contact snapshot is rechecked under the writer lock. Screening and the Harvest
snapshot retain the existing caller behavior. No paid provider is called here.

## Verification

- 61 edit tests plus13 recipient/read tests, including concurrent Sends, a racing
  recruiter commit, verification-only address, failed verification read, forged
  contact, suppressed/altered witness and post-Send resume upload/fill auditing.
- 20 actual route tests with sealed external I/O.
- 101 post-cutover audit tests, including14 insertion-witness cases.
- 504 cross-family tests and48 SQL assertions on the combined prepared chain.
- 11 publication-admission tests,10 maintenance tests with each of the current and
  frozen runners,23 recruiter tests, TypeScript and email escaping pass.
- Independent review has no remaining Critical or Important findings. Exact
  preview tenancy remains the integration gate.

Install order is061000→070000→080000. No prepared migration or application flag
has been activated in production; release remains subject to Spencer's approval.
