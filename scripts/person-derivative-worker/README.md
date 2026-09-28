# Certified embedding worker

Prepared only. With `PERSON_TRANSITION_SUPPORT=on`, live mode and an OpenAI key,
the nightly `refresh-queue` run finishes by calling `runCertifiedDerivatives`. It
embeds people whose sources changed through the admitted consumer lifecycle (#70).
`DERIVATIVE_DAILY_CAP` sets the most people it pays for per run (default 200).

Each run does two things:

1. **Retained work.** A lifecycle whose vectors are stored and whose lease is live
   is published. One whose lease has passed is recovered.
2. **New jobs.** For each pending job, within the cap:
   - claim it;
   - if chunks are missing, certify the provider start, call OpenAI for only those
     chunks, and store the vectors;
   - publish.

`20260928080000_person_derivative_publish.sql` adds:

- **Publication.** It replaces the person's `candidate_embeddings` exactly as the
  legacy completion does: it keeps reusable rows, deletes the rest, and inserts
  the missing ones. It marks the job `done` with its completed hash through the
  journal, and closes the lifecycle as `published` with its work completed. No
  provider call.
- **A definite provider failure.** An HTTP error response means no result and no
  charge. The lifecycle closes as `failed`, the job returns to `pending`
  (`provider_failed`) and the work completes. That failed request does not block
  the person's next paid start. A lost response (transport error or unreadable
  body) stays unknown, never pays twice and stays held, as in #70.

The worker does not maintain `candidates.matching_embedding` for directory and
refresh saves. Search (`match_candidates_v2`) takes the nearest of that vector and
the chunk embeddings, so current chunks keep people findable.

## Verification

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-derivative-worker/run-local-tests.sh PORT
```

On 2026-09-28 (fake provider, synthetic people):

- **Worker harness:** 365/365, including 5 new tests:
  - publish after a paid store;
  - publish with every chunk retained and no provider call;
  - a definite failure that returns the job to pending and doesn't block the next start;
  - publish refused before vectors are stored;
  - the worker's cap, publication, and definite versus unknown failures.
- **Lifecycle harness:** 528/528 with this migration installed.
- **Type check:** `tsc` passes.

Not tested: a real OpenAI call, production, or the refresh-queue workflow end to end.
