# Release manifest: candidate storage remediation branch

Identifies the exact artifact the evidence in `RELEASE_REMEDIATION.md` refers to.
Any change to source, dependencies, migrations or configuration invalidates the
rows that depend on it until re-verified. The commit and tree below are the state
**before** this manifest and the ledger were committed; the final commit that adds
these two files changes HEAD but not any executable file (update the two hashes
when that commit lands, nothing else moves).

## Source

| Item | Value |
|---|---|
| Branch | `fix/person-90-release-remediation` (worktree `pl/remediation`) |
| Base | `c8fda5bfd50e8c40f22a3083e38c6eea71d0a803` (`feat/person-00-storage-unification`, tree `d43305e1…`, includes `main` `9a3240c`) |
| Merged in | `origin/fix/drawer-profile-layout` `dad9549`, `origin/feat/drawer-also-a-match` `c042c21` |
| Head (executable content) | `0617a926bfcb484328f74efc8f537e3e97b8019d`, tree `3d278ec9cfa07a5551d5a26424b00d3a323714f7` |
| Commits on top of base | `47005c2`, `4ecdffb` (UI merges), `3862042` (target isolation), `4f23107` (forward migrations), `924f233` (recovery tests), `0617a92` (docs) |
| Diff vs base | 53 files, +2,330 / −52 |
| Excluded testing-branch content | diagnostic route and diagnostic log lines (`5db31f1`, `ce72331`, `8bc18b9`) |

## Dependencies and worker bundle

| Item | Value |
|---|---|
| `package-lock.json` SHA-256 | `2c4ff8ad43b5cae55f06580afd4b7711f2beaeb2b0900f8c45acee2bd2fa51c5` (identical to `c8fda5b`) |
| Node | v24.1.0 (`/opt/homebrew/bin/node`) |
| `scripts/dist/worker-lib.mjs` SHA-256 (built from this tree by `scripts/build-worker-lib.mjs`, esbuild 0.28.2) | `a222e0eff9ed6338fe8e92d06ae5d4cc104531dd2c715569cdfa9e9223df7f3d` |
| Catch-up runtime pin | `c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc`; `start-catchup.mjs` rebuilds and hashes its bundle at run time |

## Migrations

132 files under `supabase/migrations`. The release chain is the 53 files
`20260926033900` … `20260928090000` listed in the cutover runbook, followed by the
four remediation files:

| Version | Purpose | MD5 of file |
|---|---|---|
| `20261003090000_person_target_identity.sql` | `public.person_target_identity()` cluster identity RPC (service_role, read-only) | `f8e1a230eb081172bc05e84e28cc0335` |
| `20261003100000_person_forward_application_contact.sql` | release `person_application_contact_fill` body (phone extension) | `dd3a0c37536ce9b4860f03e2d20bdeab` |
| `20261003110000_person_forward_network_send.sql` | witness proof columns + hash-proven recovery; two-argument `person_network_send`; snapshot export | `30fd1fbb7a2d0f5882e36d118ba244d0` |
| `20261003120000_person_forward_identity_index.sql` | validation-only identity index preflight | `d63ff3b6a035ef6b6840291e8ab54e62` |

Older bodies the copy installed (fixtures used by the upgrade harness, captured
from `23d7860`): `old-20260928070000_person_network_send.sql` MD5
`8871cbec547a7f6129406111231b4157` (its installed function body MD5 on the copy
is `d6b75f860741aad94c10b1dfc8350c6c`, per the review's Q06).

Static parity: forward bodies equal the chain bodies
(`scripts/person-release-upgrade/test-forward-definitions.mjs`, 4/4).

## Effective configuration and destinations

| Setting | Required value / rule |
|---|---|
| `PERSON_TARGET_PROJECT_REF` | the one project ref (production `kmuihequfurvjxpnugxf`; copy `qsqlgibgsxzlimoegcjx`; `local` for loopback fixtures). Required for shadow/live or transition support with any hosted client, and for every hosted operator URL |
| `SUPABASE_URL` / keys | `https://<ref>.supabase.co`; JWT `ref` claim = selection |
| `PERSON_DATABASE_URL` | shared pooler, user `postgres.<ref>` (6543 for the app/workers) |
| `PERSON_PUBLISH_DATABASE_URL` | 5432 session/direct endpoint of the same ref |
| `OUTBOUND_DENY_HOSTS` | rehearsal deployments only; unset in production |
| GitHub Actions | repository variable `PERSON_TARGET_PROJECT_REF` consumed by review-queue, refresh-queue, sync-candidates, derivative-worker |
| Verified destinations in this task | loopback 127.0.0.1:55487 (all database tests); copy `qsqlgibgsxzlimoegcjx` read-only (cluster id `7550817586112808987`); original project: no query, no write |

## Tests executed on this artifact (2026-10-03, all pass)

| Suite | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit` | clean |
| Production build (empty env) | `env -i PATH HOME npx next build` | exit 0 |
| Target/guard offline | `bash scripts/person-target/run-offline-tests.sh` | 40/40 |
| Transport | `node --test scripts/person-db-session/test-transport.mjs` | 16/16 |
| Start-catchup | `node --test scripts/person-maintenance/test-start-catchup*.mjs` | 33/33 |
| Internal resume access | `bash scripts/person-internal-resume/run-offline-tests.sh` | 13/13 |
| Forward definitions | `node --test scripts/person-release-upgrade/test-forward-definitions.mjs` | 4/4 |
| Application edits, clean install incl. forward files | `bash scripts/person-application-edits/run-local-tests.sh 55487` | 61 + 13 |
| Upgrade path | `bash scripts/person-release-upgrade/run-upgrade-tests.sh 55487` | 25 (old schema) + 4 (after) + 61 + 13 (fresh old install + upgrade) |
| Transition rehearsal + recovery | `bash scripts/person-transition-cli/run-local-tests.sh 55487` (current and `PINNED_RUNNER_DIR=pl/pinned`) | 8 + 6, twice |
| Maintenance windows | `bash scripts/person-maintenance/run-local-tests.sh 55487` (current and pinned) | 10, twice |
| Publish/undo/guard | `bash scripts/person-publish/run-local-tests.sh 55487` | 10 + 18 + 4 + 8 |
| Post-cutover audit | `bash scripts/person-audit/run-postcutover-audit-tests.sh 55487` | 15 + 9 + 13 + 25 + 20 + 19 |
| Directory outcomes / index | `bash scripts/person-directory-outcomes/run-local-tests.sh 55487` | 6 + 40 + 35 + 12 |

Not executed (needs a deployment this branch may not make): hosted
`node scripts/test-tenancy.mjs --base <preview>`; browser smoke of the drawer
changes; runtime destination attestation of the exact deployment.

## Retained data exceptions and remaining approvals

- 23 `candidate_experiences` rows / 3 absent owners: pre-migration debris, facts
  preserved under living owners; disposition pending (RR-10).
- Copy publication paused at 2,000 outcomes with 1 `audit_blocked`; 421,044 without
  projection state; 2,271 remaining under the partition; 5,488 open identity conflicts
  (retained by G5); 2 source-date holds.
- The copy's single Send witness is in the old shape until `20261003110000` is
  installed there.
- Approvals outstanding: push/preview, copy install, RR-10 disposition, rehearsal and
  production sitting, PR review (see ledger).
