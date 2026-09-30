# Disabled transition foundation

Prepared support for a later coordinated candidate-writer cutover. Nothing in this
child enables enforcement, converts a route or adds source-table triggers. Do not
activate it independently. `PERSON_TRANSITION_SUPPORT` defaults off; unknown
values fail closed. Support on requires the schema. `PERSON_WRITE_MODE` is separate.

The private ledger binds organization, scope, family, resource key and immutable
SHA-256 input identity. Callers must hash the first submission snapshot and resume
object/version; those payloads and credentials must never enter logs. Generate a
random UUID token on the server and preserve it across a lost claim response.
Competing owners get `busy`; changed inputs cannot replace the first claim.
Completed work is terminal; expired and uncertain work remain unresolved. There
is deliberately no automatic lease takeover or paid retry in this foundation.

TT admissions take shared lock 72005, then the controller row, then the work row.
Call the explicit assertion before existing family or business-row locks. Operator
transitions take exclusive 72005, then the controller; they use READ COMMITTED and
compare revision/generation. Drain stops new admissions but permits already owned
work to complete. Held requires zero active, expired and uncertain TT work. Seal,
reopen and disarm rotate generation. Tenant application work has separate immutable
scope and does not block or stop with TT. No lock spans a provider/network call.

Privileged functions and tables live in `person_private`. Public RPCs are invoker
shims, executable only by the service role. Application credentials cannot alter
the controller or ledger directly. The operator-only `transition_set` function
is not exposed as a REST RPC. No operator CLI is supplied yet.

`withTransitionWork` scopes credentials to trusted server code. `sbRest` strips
reserved headers supplied by its caller, transports only the async context and
rejects redirects while carrying credentials, including token-bearing claim/renew/finish RPC bodies before an async context exists. `bindTransitionWork` uses SET LOCAL
inside an already begun direct transaction. Its caller must still invoke the
matching database assertion; binding alone grants no write authority. Current
routes never enter this context, so preview/production defaults remain compatible.

## Validation

Run `PSQL=/path/to/psql bash scripts/person-transition/run-local-tests.sh PORT`.
The harness resets only the loopback `person_transition_test` database. It covers
concurrent claims, exact scope/token checks, lease uncertainty, tenant independence,
controller/write races, old snapshots, SQL privileges and a synthetic row trigger.
Real loopback HTTP tests exercise `sbRest` through a small test bridge which sets
PostgREST's documented request-header setting and invokes the real PostgreSQL RPCs.
This bridge is not a hosted PostgREST deployment test. Missing schema, malformed
responses, nested/concurrent contexts, caller-header injection and redirects are
covered. No providers or messages are called.

## Still required before activation

- Queue-first public input/resume persistence and atomic organization review-budget
  reservation bound to durable work; the admission RPC alone does not reserve cost.
- All source/proof/normalized/derivative table fences with reviewed owner mapping,
  legacy writer coverage and special handling of new unlinked queued applications.
- Application, refresh, directory and recruiter integration, including retained
  family claims, late responses, explicit recovery and safe deferral of cursors.
- A tested maintenance admission/runtime policy for the pinned historical runner.
- Whole-system drain accounting, canary isolation and Spencer's release approval.

Related documentation: [PostgREST transaction headers](https://docs.postgrest.org/en/v12/references/transactions.html#request-headers-cookies-and-jwt-claims)
and [PostgreSQL locks](https://www.postgresql.org/docs/15/explicit-locking.html).
