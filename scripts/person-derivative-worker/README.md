# Certified embedding worker

Prepared only. With `PERSON_TRANSITION_SUPPORT=on`, live mode and an OpenAI key,
the nightly `refresh-queue` run finishes by calling `runCertifiedDerivatives`. It
embeds people whose sources changed through the admitted consumer lifecycle (#70).
`DERIVATIVE_DAILY_CAP` sets the most people paid for per UTC day, counted from the
database across runs (default 200; a bad value fails the run before any work).

Each run does two things:

1. **Retained work.** A lifecycle whose vectors are stored and whose lease is live
   is published. One whose lease has passed is recovered.
2. **New jobs.** Only while the controller is open or disabled. For each pending
   job, within today's remaining cap:
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
- **A definite provider failure.** A clear rejection means the request was refused,
  not processed and not billed: 400, 401, 403, 404, 413, 422 or 429, or input the
  worker refused before sending. The lifecycle closes as `failed`, the job returns
  to `pending` (`provider_failed`) and the work completes. That failed request does
  not block the person's next paid start.
  - A 401, 403 or 429 stops the run, so one outage costs one attempt, not everyone's.
  - A 5xx, another status, a transport error or an unreadable body may have been
    processed. It stays unknown, is never paid again, stops the run and fails it.
- **Retries and replays.** Storing a paid result is retried on a lost connection. A
  repeated publish returns the retained result.
- **Attempt limit.** Jobs that reach three attempts are counted in the run summary
  (`attempt_limited`).

The worker does not maintain `candidates.matching_embedding` for directory and
refresh saves. Search (`match_candidates_v2`) takes the nearest of that vector and
the chunk embeddings, so current chunks keep people findable.

## Verification

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-derivative-worker/run-local-tests.sh PORT
```

On 2026-09-28 (fake provider, synthetic people):

- **Worker harness:** 370/370, after an independent review, including 10 new tests:
  - publish after a paid store;
  - publish with every chunk retained and no provider call;
  - a definite failure that returns the job to pending and doesn't block the next start;
  - publish refused before vectors are stored;
  - a repeated publish;
  - the worker: the cap across runs, clear rejections, a provider-wide stop, unknown
    results, a store retry, and no claims while draining.
- **Lifecycle harness:** 528/528 with this migration installed.
- **Type check:** `tsc` passes.

Not tested: a real OpenAI call, production, or the refresh-queue workflow end to end.
