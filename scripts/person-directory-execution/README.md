# Certified directory shadow execution (prepared only)

`saveCertifiedDirectoryOnConnection` accepts TT organization, workspace, receipt,
a caller-retained execution UUID and `shadow` mode. It loads a privately certified
receipt, resolves one existing migrated candidate, captures actual source and
candidate-wide predecessor evidence, runs the deterministic evaluator, and saves
through the existing normalized writer. The entire legacy candidate row stays
unchanged. The scan/CLI, creation, suppression, live publication, re-evaluation
under a new UUID and embeddings remain unavailable with transition support on.

The dedicated private writer capability is intentionally **not** granted to
`service_role`, anon or authenticated. There is no public arbitrary-document seal
RPC. Deployment must verify that the dedicated `PERSON_DATABASE_URL` role can
execute the private functions; otherwise the operation fails closed. The trusted
server evaluator calculates documents/reviews; SQL independently selects and
checks the input rows. This is not a second SQL implementation of the parser.

Controller/work ownership precedes identity, contact, receipt/state and candidate
locks. A private execution UUID lock serializes cross-receipt UUID reuse before
work creation. Ownership is checked after waits. Separate directory frames share
existing normalized row/resolver checks without inventing an application work.

Sealed documents, exact primary changes/ranks/revision, audit proof, receipt/state
completion and work completion commit together. Partial execution cannot commit,
and generic transition finish cannot manufacture completion. Same-UUID response
loss returns its retained result, including while held or after later edits.
Different bindings and a new UUID for an already completed receipt are refused.
A changed or hidden certified predecessor requires review. The common audit
registry checks genuine completed directory operations and preserves application
creation/attribution rules. No directory candidate-write attribution is enabled.

Run the caller-owned loopback fixture only:

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-directory-execution/run-local-tests.sh 55487
```

The runner resets only `person_directory_execution_test`, builds the real writer
bundles, and installs the full prepared chain. Tests cover genuine TT intake and
audit interoperability, exact candidate preservation, response-loss replay,
private/service permissions, rollback at save boundaries, partial commit refusal,
controller/identity/candidate lock waits, expiry, source/predecessor substitution,
normalization frame suppression/alteration/nesting, conflict/lookup compatibility,
primary revision suppression, timezone-independent audit certificates and legacy
support-off behavior. A synthetic 80-job/20-education/120-skill snapshot exercises
the existing statement-time limit. All external effects are synthetic or denied.

This migration is uninstalled. Passing these tests does not authorize production
activation or certify the remaining writer, derivative, maintenance and canary
families.
