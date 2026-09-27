# Queued application intake (prepared, default off)

`PERSON_TRANSITION_SUPPORT=on` routes new applications, referrals and future
interest through durable queued acceptance and a shared database admission.
TT processing also requires `PERSON_WRITE_MODE=shadow|live` and the website-only
`PERSON_DATABASE_URL`. These settings are **not enabled by this change**.

Public acceptance stores supplied resume bytes successfully before inserting an
application, with a content hash and `person_processing_version=1`. Future
interest uses a semantic intent hash and an atomic organization/LinkedIn/intent
key; an identical retry does not schedule another callback. New preferences keep
a separate accepted row. LinkedIn usernames use the same decoded, trimmed,
lowercase identity accepted by normalized intake.

One shared claim owns the organization allowance, immutable input snapshot,
lease and unguessable server token. No provider or resume processing precedes
admission. Before effects start, transient failures can defer and a new owner
can resume the same reservation; retired tokens cannot return. Permanent resume
mismatches enter durable input review. Once effects have started, uncertain or
expired attempts never automatically repeat paid calls. New stages renew the
lease and required source writes must succeed before `processed` and completion.

Queue discovery skips exhausted organizations, active/delayed work, input holds
and transferred reservations, while counting all waiting/review work. A bounded
1000-ID lookahead handles budget changes after discovery; the requested maximum
still caps processed/failed attempts. Previously reserved deferred work does not
need another allowance. **All legacy unversioned queued rows need prior-effect
review, including rows without files or with valid hashes.** Do not bulk stamp
them as version 1 or clear private holds to force a retry.

TT intake binds and asserts work before family locks, under transaction timeouts.
It uses retained input, rejects external drift and accepts only its own
receipt-proven output on deterministic replay. Contact, resolved name, normalized
facts and receipt commit together. Tenant contact filling uses organization scope
and a complete contact-block compare-and-swap; a race fails closed.

Future preferences serialize with future acceptance using the username lock.
Only the newest accepted intent may update the candidate. A private sequence
journal and immutable decision proof let the separate auditor check historical
latestness, including intents which were unlinked at that time. Later arrivals
cannot invalidate an earlier valid decision. Tenant intent evidence cannot
justify a TT candidate mutation. Read-committed isolation is required.

Lead notices retain their original callback behavior and are best effort; queue
recovery never resends them. Auxiliary mirrors remain best effort. There is no
notification outbox or claim of provider exactly-once delivery.

## Local validation

Only synthetic loopback databases owned by these scripts are reset. Provider
and notification requests in route/pipeline tests are intercepted mocks.

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-application-queue/run-local-tests.sh 55487
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-application-queue/run-intake-tests.sh 55487
```

The first suite covers lifecycle/queue concurrency and actual bundled public
routes/pipeline with mocked network. The second installs the complete prepared
migration chain and runs claimed normalized intake, historical audit evidence,
contact rollback, tenant isolation and real two-session ordering/timeout tests.

Prepared migrations `20260927004931` and `20260927013100` follow the application
work primitive `20260927001258`. They are not installed in production. Remaining
release gates include every writer's source/normalized/derivative fences,
maintenance for the frozen historical runtime, isolated website/worker canaries,
combined release checks and Spencer's approval. Installing this partial chain
or enabling support alone does not establish those gates.
