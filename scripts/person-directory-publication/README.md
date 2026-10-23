# Prepared directory publication

`saveCertifiedDirectory` now accepts `live` for an existing migrated candidate.
The server derives identity and documents from a certified receipt. It normalizes,
checks the primary contact and revision, projects current normalized winners,
records directory metadata, and durably queues both derivative forms in one
transaction. Application and directory publication share projection serialization
and checked SQL, while retaining separate source bindings and execution frames.

A new execution UUID can publish the latest genuinely completed shadow receipt.
It adopts the original decision and preserves both UUID results; it does not
re-evaluate old evidence against newer facts. A superseded or tampered receipt
cannot publish. New live intents for an already live receipt remain unsupported.

Prepared migration `20260927150000` is **not installed in production**. The legacy
worker/CLI remains gated with transition support on. Creation, suppression,
reviewed outcomes, consumer admission and remaining writer families are release
prerequisites. This branch does not enable flags, deploy main, consume embeddings
or publish production profiles. Private publication capabilities are not granted
to the generic service role.

Run the complete local fixture on an owned PostgreSQL 15 loopback instance:

```sh
PSQL=/path/to/psql bash scripts/person-directory-publication/run-local-tests.sh PORT
```

It resets only `person_directory_publication_test`, installs the prepared chain,
and exercises real application/directory transactions, immutable replay, before-
images, audit attribution, unique-index and producer lock waits, unchanged-content
job retries, mutation suppression/alteration, source decisions and legacy behavior.
