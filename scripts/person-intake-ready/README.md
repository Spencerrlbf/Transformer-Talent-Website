# Prepared TT intake readiness proof

`20260927060000_person_intake_ready.sql` is an uninstalled dependency for later
workflow completion. A receipt or mutable `processed` status does not prove that
all intake work completed. This migration records private stage evidence, then
requires an immutable readiness record before the first candidate binding commits.

Readiness binds one work item, application, candidate, receipt and original
transaction to its metadata witness, checked finalization event and preference
disposition. Live intake and new people in shadow mode require checked projection
at the current normalized revision. Existing shadow intake records its deliberate
lack of publication. A metadata no-op still requires a witness and retains the
requested mode.

Future preferences are explicitly applied, superseded or inapplicable. Supersession
requires validated own input and an observed newer same-organization/person intent,
including an unlinked request. An incomplete future input fails validation.
Applied decisions and supersession keep their original ordering evidence; later
requests cannot invalidate a previously legitimate decision. Finalization and
preferences return retained proof on replay without repeating their mutations.
Historical missing readiness cannot be reconstructed from today's candidate values.

Private helper/core execution and proof-table writes are revoked from service
callers. First readiness checks actual metadata, application fields and projection;
its deferred commit check verifies retained stage, event and preference evidence.
Later replay validates those immutable references, preserving legitimate later
candidate changes. No production installation or activation is authorized here.

```sh
PSQL=/path/to/psql bash scripts/person-intake-ready/run-local-tests.sh LOCAL_PORT
```

The 25-test harness owns only loopback `person_intake_ready_test`, uses synthetic
inputs and blocks provider requests. It covers omitted stages, projection/mode
requirements, no-op metadata, future input validation, supersession, cross-operation
proof reuse, deferred rollback and replay after later genuine preferences. Full
claimed intake, both preference lock orders, projection, normalization, audit proof,
auditor, local canary, legacy writer/UI and build checks run on the combined chain.

This child does not close application workflow completion. A later atomic result
and completion operation must consume readiness; tenant person binding/results,
public acceptance/source edits, other writer families, derivatives, maintenance
and whole-worker canary/drain behavior remain release prerequisites.
