# Prepared tenant application binding

`20260927065000_person_tenant_binding.sql` is an uninstalled prerequisite for
checked result completion. Client applicants remain in their own organization's
applications; this bridge never writes TT candidate or normalized tables.

On first binding, the earliest eligible application currently visible for an
organization and canonical LinkedIn username is selected by `created_at`, then
ID. A private persistent mapping freezes that choice. Concurrent work shares the
mapping, and an earlier-dated application committed later cannot retarget it.
Missing usernames use their own application and create no shared identity map.
The initial selection preserves the current visible first-application semantics;
this operation does not merge or rewrite historical verdicts.

Every call requires an owned, started, unexpired application work item and exact
accepted input. Work locks precede identity and application locks; lease checks
repeat after waits. The current application and retained anchor must still belong
to the admitted organization and identity and must not be a TT Send. Changed
anchors fail closed without remapping. Foreign keys prevent deletion from
silently recreating identity. Tenant work remains independent of the TT hold.

Private maps and context helpers deny service-role access; only the checked RPC
is exposed. The TypeScript bridge validates arguments and RPC scope, propagates
errors without a REST fallback and requires admission whenever transition support
is enabled, including the missing-username path. Support-off behavior is retained.

```sh
PSQL=/path/to/psql bash scripts/person-tenant-binding/run-local-tests.sh LOCAL_PORT
```

The harness resets only loopback `person_tenant_binding_test`, uses synthetic
data and prevents provider requests. Its 22 PostgreSQL checks cover concurrency,
late commits, tied dates, company separation, missing identity, TT isolation,
changed anchors, actual lock waits with expired leases and private ACLs. Its 12
bridge checks cover claimed contexts, argument/response validation, errors,
missing admission and legacy compatibility. Broader prepared-chain intake,
projection, normalization, audit, queue, canary and legacy writer checks run
separately; this slice is not a full worker drain rehearsal.

Atomic results/contact completion must consume this binding next. Public source
acceptance and edits, other writer families, derivatives, maintenance and whole
worker canary/drain coverage remain release prerequisites. No migration, runtime
flag or production behavior is activated by this child.
