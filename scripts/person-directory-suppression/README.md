# Prepared directory suppression

A certified directory receipt can set an existing person's status to **Do Not
Contact** in either requested mode. Source-date holds, missing normalized state
and missing audit anchors do not prevent this safety update. Identity/linkage
conflicts and supersession retain their earlier precedence. Global controller
holds still refuse new work; a completed UUID replays its original result.

The private outcome proof retains the original candidate, exact target and actual
captured UPDATE. Only status and its update timestamp can change. Resumes, notes,
embeddings, profile facts, source/linkage, follow-up, normalized data, directory
applied state and derivative work remain untouched. Existing DNC is a full-row
no-op with no new candidate UPDATE. Whole-row checks remain distinct from event
payload checks because capture intentionally omits resume text, embeddings and
notes. The witness is covered by the independently retained outcome hash.

Suppression does not claim historical verification, create an audit anchor,
admit normalized documents or publish a profile. Its status change is neutral to
the existing candidate contract hash; event/queue capture still records the write.
The offline auditor may retain `directory_snapshot_not_admitted` until a genuine
profile receipt is admitted. Later application/directory writes retain sticky DNC
and can pass the existing audit chain normally.

Migration `20260927180000` is **prepared only, not installed in production**.
Main, flags, worker routing and consumers remain held. Same-source outcome
re-admission under a new UUID remains a worker prerequisite, including an unknown
suppressed identity later admitted by an application. No public or service-role
suppression API is granted by this migration.

Run on caller-owned PostgreSQL 15 with `auto_explain`:

```sh
PSQL=/path/to/psql bash scripts/person-directory-suppression/run-local-tests.sh PORT
```

This resets only `person_directory_suppression_test`. Tests include the full
prepared chain and legacy suites, strict publication guards, both modes and
eligibility states, private/public mutation and event failures, nested authority,
cleanup failures, real lock expiry, partial commits, and immutable replay after
later legitimate writes. No external enrichment or messaging occurs.
