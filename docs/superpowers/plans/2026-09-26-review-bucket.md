# Candidate review worklist and publication prerequisites

Updated from aggregate database checks at 2026-09-26 22:39 UTC. Spencer's
recorded preference is to publish people with identity reviews and retain those
reviews for later resolution. This preference does not supply missing source
proof, clear a hold, or authorize release. Main and production activation still
require his approval.

## Exact current accounting

The latest counted reconciliation result for each pool candidate gives:

| Outcome | People |
|---|---:|
| Verified at the observed normalized revision | 422,925 |
| Same-snapshot source mutation requiring review | 123 |
| Unknown original Harvest fetch date, on hold | 2 |
| Missing check or pending check | 0 |
| Total pool | 423,050 |

There are 5,483 open identity/contact/employer conflict records affecting 9,346
distinct pool people. Five people appear in both the source-review and open
conflict populations; do not add these populations together. Both date holds are
already included in the 125 source reviews. One held person has normalized state;
the other does not. There are 423,049 normalized states in total.

These are observations, not a globally stable source snapshot. The external
fingerprint changed during both the full scan and the later directory catch-up.
The directory run finished as `review_required`; no source review was cleared by
labeling the traversal complete.

## Identity and contact reviews

Every publication outcome below still requires a valid immutable anchor and
intact evidence chain. `--review=publish` only bypasses the identity-conflict
filter. It does not bypass these prerequisites or source-date holds.

| Conflict kind | Open records | Stored behavior and later review |
|---|---:|---|
| Identity already owned by another candidate | 4,515 | Separate candidate rows and facts remain. The disputed identity remains on its existing owner; ownership needs evidence review. |
| Email also held by another candidate | 511 | The normalized contact remains on each holder and `email_owned_by_other` is recorded. Duplicate ownership records a review; contacts explicitly marked shared or otherwise ineligible cannot become primary. |
| Missing identifiable employer | 416 | The job remains with an explicit Unknown employer and a review record. |
| Ambiguous job identity | 40 | History remains; no speculative rekey or person merge. |
| Ambiguous company identity | 1 | Review remains; no speculative merge. |

The original identity breakdown was 3,954 numeric LinkedIn IDs, 560 LinkedIn
usernames and one Airtable ID. That describes collision records, not a count of
proven duplicate people. A shared name or identifier alone does not establish a
safe merge. The old import can contain contradictory identifiers; compare each
row's original evidence before proposing a correction.

Normalized contact collisions differ from the unique compatibility email column.
The earlier read-only projection comparison observed 272 proposed
`candidates.email` collisions. Publication preserves today's compatible address
and records `legacy_email_collision`, unless that current address has become
invalid under the contact rule, in which case it may be cleared. Recompute this
preview on the reviewed release before publication; 272 is a historical estimate,
not the current publication outcome.

Any duplicate merge, identity correction or paid enrichment is separate reviewed
work. This migration does not merge people or commission fresh Harvest pulls.

## Source-proof reviews

The full reconciliation finalized at 19:52:54 UTC with 85 same-snapshot mutations
and two date holds. The later directory catch-up checked all 62,208 linked people
and found 62,083 verified and 125 reviews. The latest global result is the 123
same-snapshot mutations and two holds shown above. The historical 85 and current
123 are different observations; do not sum them.

A same-snapshot mutation means a source component changed without the dated
provenance needed to accept it as a newer document. A bounded catch-up or future
receipt does not automatically repair that evidence. The directory writer retains
same-date changed components for review, and existing-candidate intake checks the
anchor before source admission. A person without valid historical proof cannot
be published from copied facts merely by selecting `--review=publish`.

Preserve the old and new evidence. Resolution needs a separately reviewed policy
that establishes which document is admissible and how its historical anchor and
subsequent receipts can be verified. Do not overwrite an immutable anchor to make
an unexplained edit appear valid. Until that policy and its tests exist, report
these people as blocked by source proof rather than ready for publication.

## Source-date holds

Two retained cache payloads have no provable original fetch date. Both people
remain excluded from publication. Only one lacks normalized state; the other
already has a normalized copy, which does not remove the hold.

Fresh dated evidence may support future facts, but it does not establish the
missing historical date of the retained cache payload. Any later fresh pull,
hold resolution and anchor eligibility must follow separately reviewed provenance
handling. Never substitute the cache reuse date, discard the unresolved evidence,
or treat a fresh pull alone as permission to clear a hold.

## Evidence and follow-up

The final directory run is `person-reconcile-directory-20260926-evening`, frozen
runtime `c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`, parser `person-v3`.
It finalized once at 22:38:55 UTC. Private metadata-only artifacts
`directory-finalization.json` and `directory-final-accounting.json` retain the
counts and source fingerprints. No personal source content belongs in this report.

Before release, present current verified/review/held counts, the exact accepted
runtime, unresolved source-proof policy, identity review behavior and rollback
procedure together. Candidate IDs, links, original source evidence and live
legacy fields remain preserved while release preparation continues.
