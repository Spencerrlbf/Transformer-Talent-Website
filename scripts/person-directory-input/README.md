# Checked directory inputs (prepared only)

This foundation retains a directory observation as an immutable website receipt.
Five typed RPCs claim/checkpoint a workspace scan, stage an input, inspect a page
and recover pending inputs. Private certification binds the TT organization,
workspace, contact, receipt ID, legacy deduplication hash, actual retained snapshot
and original capture epoch. The certificate uses a versioned database SHA-256.

Matching legacy hashes also require equal ordinary fields and equal multisets
for all six list fields, including duplicate counts. Array reordering can reuse
the original receipt without rewriting its snapshot. Uncertified old receipts
return `input_review`; recovery through the TypeScript adapter throws
`person_directory_input_review`. A later reviewed adoption path is required.

A controller lock precedes scan/contact/state locks. Claims stop while held or
draining; existing scanners may retain an observation, but cannot advance the
cursor or complete a cycle while held. Tokens and lease expiry are checked after
waits. Exact mutation frames and readback detect altered or suppressed scan,
receipt, state and certificate writes. Certified immutable fields stay protected
when enforcement is disabled. Snapshot limits are 2 MiB and 10,000 entries per
list (phone rows retain their existing string-or-object form); page inspection is limited to 100 snapshots and 16 MiB. Oversize input
fails without advancing a scan.

This is **not directory save admission**. `PERSON_TRANSITION_SUPPORT=on` stops the
actual directory CLI before mode dispatch/network access, and stops direct save
and embedding entry points. Do not enable the workflow flag until directory,
refresh, recruiter, derivative and maintenance integration and canaries pass.
Support-off legacy behavior remains compatible. No migration in this child is
installed in production, and no communications or `_v2` database is written.

Run the isolated full-chain fixture (PostgreSQL 15 on loopback):

```sh
PSQL=/path/to/psql bash scripts/person-directory-input/run-local-tests.sh PORT
```

This resets only `person_directory_input_test`. It covers source collisions,
replay, pending-input recovery, explicit review, tampering/suppression, real
controller/scan/contact/state waits and expiry, CLI refusal, application/lookup/
conflict regressions and support-off directory behavior. All fixtures are
synthetic; external connections and providers are denied in the actual CLI test.
