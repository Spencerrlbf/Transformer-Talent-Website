# One explicit project for every normalized-storage process

`scripts/person-target.mjs` is the single authority for *which Supabase project a
process may touch*. The Next.js server (`lib/server/person/target.ts`), the bundled
worker library and the operator CLIs import the same module. It answers release
review findings RR-06 (original-only procedures and hidden original defaults),
RR-07 (browser Auth target does not prove server/worker isolation) and RR-08
(copied grants and inherited provider credentials).

## Selecting the project

```
PERSON_TARGET_PROJECT_REF=<20-letter Supabase project ref>   # hosted project
PERSON_TARGET_PROJECT_REF=local                              # loopback fixture only
```

Nothing defaults to the website project. The selection is **required** whenever:

- it is set at all (then it is always enforced), or
- `PERSON_WRITE_MODE` is `shadow`/`live` or `PERSON_TRANSITION_SUPPORT=on` **and**
  either client could reach a hosted project (`SUPABASE_URL` is not loopback/`.invalid`
  or `PERSON_DATABASE_URL` is not loopback), or
- an operator CLI is given a hosted PostgreSQL URL (publish, undo, guard, transition,
  anchors, catch-up start, reconcile finalize).

Legacy mode with no selection keeps today's production behavior. A sealed local
fixture (loopback PostgreSQL, loopback or `.invalid` REST) needs no selection.

## Signals that must all name the selected project

| Client | Signal | Checked where |
|---|---|---|
| REST | `https://<ref>.supabase.co` exactly (no port, path, credentials) | `sbRest`, CLIs, role utilities |
| JWT keys | `payload.ref` of the legacy anon/service key; `sb_secret_` keys carry no claim and are accepted only together with the runtime identity check | `sbRest`, CLIs |
| direct PostgreSQL | `db.<ref>.supabase.co` | `withPersonConnection`, CLIs |
| pooler PostgreSQL | `*.pooler.supabase.com` **and** username `<role>.<ref>` (the host is shared by every project in the region) | same |
| CLI workdir | `<workdir>/supabase/.temp/project-ref` | `person-reconcile-finalize.mjs --workdir` |
| transport | publish/anchor/finalize CLIs additionally require port 5432 session endpoints | CLIs |

Every check runs before a connection, queue claim, write or provider call. Failures
are `person_target:<code>` (`missing`, `invalid`, `rest_mismatch`, `key_mismatch`,
`key_unverifiable`, `database_mismatch`, `database_host`, `database_port`,
`pooler_username`, `workdir_mismatch`, `identity_rest`, `identity_database`,
`identity_mismatch`) and never contain the configured values.

## Runtime identity

Migration `20261003090000_person_target_identity.sql` installs
`public.person_target_identity()` (service_role only, read-only). It returns the
cluster's `pg_control_system()` identifier. A restored copy is a different cluster
even though every row and organization id was copied, so a REST client (RPC) and a
PostgreSQL client (direct) can be proved to reach the **same physical database**:

- `start-catchup.mjs` requires the REST identity and records it with the run;
- `person-reconcile-finalize.mjs` compares the REST and PostgreSQL identities before
  finishing a run (`person_target:identity_mismatch` stops it);
- an operator can run the same comparison by hand to attest a deployment's
  configuration without printing any secret.

## Denied provider transports (disposable deployments)

`OUTBOUND_DENY_HOSTS=api.us.nylas.com,api.resend.com,.airtable.com,api.harvest-api.com`
installs a `fetch` guard (`lib/server/outbound-guard.ts`, from `instrumentation.ts`
on the server and from the worker bundle on import). Requests to a listed host (exact
or `.suffix`) fail with `outbound_denied:<host>` before leaving the process and are
counted (`deniedRequests()`). Unset in production: nothing is installed. OpenAI and
the selected Supabase project stay reachable unless listed.

## Deployment checklist

- Vercel: `PERSON_TARGET_PROJECT_REF` on every environment that runs shadow/live or
  transition support; for a rehearsal branch also `OUTBOUND_DENY_HOSTS`, test provider
  keys, and the copy's URLs/keys.
- GitHub Actions: repository variable `PERSON_TARGET_PROJECT_REF`; the four
  normalized workflows pass it to the workers.
- Operator shells: `PERSON_TARGET_PROJECT_REF` next to `PERSON_PUBLISH_DATABASE_URL`
  / `PERSON_DATABASE_URL`.

## Tests

```sh
bash scripts/person-target/run-offline-tests.sh   # no database, no network
```

`test-target.mjs` (selection and signals), `test-cli-targets.mjs` (sealed child
processes: role utilities and the finalizer stop before any socket),
`test-server-target.mjs` (mixed REST/PostgreSQL configurations refused before any
pool or request), `test-outbound-guard.mjs` (denied hosts counted, others pass).
`scripts/person-maintenance/test-start-catchup.mjs` covers the catch-up starter.
