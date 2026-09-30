# Application enrichment and legacy email boundary (prepared only)

`20260927090000_person_application_enrichment.sql` follows checked acceptance
`20260927080000`. Both remain uninstalled; installing or enabling this partial
chain requires the complete release gates and Spencer's approval.

Claimed TT processing uses checked Harvest store/cache/attach RPCs and a narrow
parser telemetry RPC. Private work ownership, exact mutation frames, actual public
rows and exact private proofs must agree. Checks run before and after mutation;
suppressed or altered trigger results roll back the transaction. Row guards take
no controller, work or identity locks. Existing statement gates precede business
locks even when enforcement is disabled. RPCs recheck their leases after waits.

The first cache selection is retained per work, including the original candidate
owner and a fingerprint of all evidence other than the candidate link. Retry uses
that selection even after the freshness cutoff advances or newer evidence arrives.
Missing or changed evidence throws; it cannot silently cause another paid lookup.
Timestamps hash by epoch so session timezone does not change the fingerprint.
Historical unowned rows remain reusable. Attaching one preserves the original
payload, date and spend. A concurrent work's attachment is accepted on a retained
read only with matching committed receipt, private binding and readiness. An
original nonnull owner cannot be cleared or reassigned. Other-work paid evidence
is reusable only after receipt-backed finalization and remains read-only.

`person_application_parser_record` accepts only `llamaparse` or `pdf-parse`.
It derives the TT candidate and username from active work with private intake
readiness and an accepted resume path/hash. Telemetry contains no raw/normalized
payload, uses zero credits, and replays only for the same parser and intact proof.
The application calls it after intake. Failure logs a fixed code and never falls
back to a raw write. Tenant and support-off processing retain their spend path.

When normalization is required, all OLD/NEW TT enrichment mutations and all
nonnull candidate links are fenced, including historical and unlinked evidence.
Existing privately owned records remain protected when enforcement is off. Tenant
spend must have no candidate link. Anonymous TT JD-parser telemetry permits only
an exact INSERT with no candidate, username, payload or credits. It grants no
later edit authority. All legacy `candidate_emails` mutations are refused while
required; admitted contacts use normalized `candidate_contacts`. Both tables
refuse TRUNCATE after installation, including owner sessions.

Run the isolated synthetic fixture (resets only `person_application_enrichment_test`):

```sh
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql bash scripts/person-application-enrichment/run-local-tests.sh 55487
```

The full prepared chain exercises real TT intake, held acceptance/reopen/drain,
source reuse, atomic completion, audit verification and the actual PDF pipeline.
SQL regressions cover private/public suppression and alteration, original-owner
changes, tenant transfers, legacy emails, stale tokens, private ACLs, and observed
work/ledger/candidate lock waits that expire the lease. All providers are mocked;
no paid calls or messages occur. Other source families, derivative and maintenance
admission, and complete production canary/drain coverage remain release prerequisites.
