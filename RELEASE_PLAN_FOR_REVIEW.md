# Candidate-storage release: plan, database shape and what is left (for review)

Written 2026-10-15 for an independent reviewer. Branch `fix/person-90-release-remediation`,
head `3f68c7f`, PR Spencerrlbf/Transformer-Talent-Website#87 (into the parent branch
`feat/person-00-storage-unification`, PR #2 into `main`). Detailed evidence: `RELEASE_REMEDIATION.md`
(ledger, sections 10–15), `RELEASE_APPROVAL_PACKAGE.md` (commands, capacity, decisions),
`RELEASE_ACCEPTANCE_CHECKLIST.md` (one row per requirement with evidence).

## 1. What the release does, in one paragraph

Today every candidate's data lives in one wide `candidates` row plus a few side tables, written
by many independent tools (imports, the LinkedIn enrichment provider, the recruiter dashboard,
applications, the communications directory sync). The release adds a normalized store beside it
(sources, contacts, jobs, educations, skills, identities, per-person state and an immutable audit
trail), a transition controller that fences raw writes while the store is being filled, and a
publication step that writes the normalized view back into the old columns so the existing site
keeps reading what it reads today. Nothing is deleted; candidate ids never change; the old columns
stay the compatibility surface.

## 2. The three environments

| | Production `kmuihequfurvjxpnugxf` | Copy `qsqlgibgsxzlimoegcjx` (paid clone) | Branch preview |
|---|---|---|---|
| Role | the live site's database; untouched so far | physical clone of production taken 2026-09-28, used for rehearsal only | Vercel deployment of the branch pointed at the copy |
| Schema | old schema: 96 recorded migrations, last `20260926050355` | old schema + all 64 release migrations (160 recorded), labelled `qsqlgibgsxzlimoegcjx` | — |
| Size | 33.9 GB, 431,978 candidates | 43.7 GB after the rehearsal, 423,062 candidates | — |
| Needed after release? | yes | **no** (rehearsal evidence is exported, then it can be deleted) | replaced by the production deployment |

Deleting the copy loses nothing production needs: the copy is a throwaway; its findings are in the
ledger and in the branch.

## 3. Shape of the production database, before and after

**Before (today).** Public tables `candidates`, `candidate_experiences`, `candidate_emails`,
`candidate_emails_v2`, `candidate_enrichments`, `website_applications`, plus the dashboard's
own tables. Writers update `candidates` directly. No controller, no audit trail, no project label.

**After the schema install (step 2 below), with the app still in legacy mode.** Everything above
is unchanged and still read and written as today. New, empty-or-filled-by-background-jobs objects:

- `candidate_sources`, `candidate_contacts`, `candidate_skills`, `candidate_educations`,
  `candidate_identities`, `candidate_profile_state`: the normalized store (one row per source
  document, per fact). `candidate_experiences` gains `source='person'` rows (the normalized jobs).
- `person_change_events` / `person_change_queue`: a capture trigger records every change to the
  old tables so the reconciler can re-read changed people (the "queue").
- `person_audit_anchors`, `person_audit_operations`, `person_change_attributions`,
  `person_projection_history`: immutable before-images and an attribution chain for every
  audited write; the basis of rollback and of the final audit.
- `person_private.*`: the transition controller (`transition_control`, `transition_events`,
  `maintenance_events`, `transition_work`), writer frames, and `target_identity` (the project
  label that stops a tool from writing to the wrong project).
- Run bookkeeping: `backfill_runs`, `person_reconcile_people`, `person_publish_runs/results`,
  `person_postcutover_audit_runs/results`.

The install is additive: 64 SQL files, each applied with its history row in one transaction, on
the 5432 session endpoint, by `scripts/person-release/apply-upgrade.sh`. No `supabase db push`.
A production backup and the Storage object export precede it.

**After publication and cutover.** Same tables; the old `candidates` profile columns now carry
the values projected from the normalized store (unchanged for most people, since the store was
filled from them), the controller is armed, and the app and workers run in live mode: writes go
through the normalized writer, with the old columns kept in sync by the same projection.

## 4. What has been done

- Code and tooling complete and verified: application tests, 913-call cross-organization leak
  sweeps (disabled and armed), installer resume proof, Storage export tests, publication and
  audit suites, local full-chain proofs. Manual acceptance 16/16 on the preview.
- The copy rehearsal ran the whole sequence in order and measured every step. It found six
  defects, all fixed in the branch: queue pager plan, armed-sweep teardown deleting evidence,
  undo refused under an armed controller, undone people refused by the armed publisher, resume
  pinned to a moving commit, and a `_v2` fingerprint that exceeded the REST gateway's 8-second
  budget (forward `20261014120000`, 7 s → 1.2 s).
- The rehearsal did **not** finish end to end: publication was stopped at the copy's approved
  45 GB disk ceiling after 163,500 of 423,062 people; the post-publication catch-up and the
  final audit were measured but not completed. Every integrity check stayed in force; no timeout
  was raised to pass a step.

## 5. Measured durations and growth (the numbers that drive the plan)

| Step | Rate / size | Production estimate |
|---|---|---|
| Schema install | 64 files, seconds each | ≤ 10 minutes, site stays up |
| Catch-up (first pass, held window) | 2,135 queued people in 16.7 min, pinned translator ≈ 2.1 people/s | minutes to an hour, depending on production's queue size; recruiter edits refused during it |
| Publication | 13.1 people/s with 16 sessions from an operator machine | ≈ 9 hours, site up and writable |
| Database growth from publication | 28.5 KB per published person net (captured events 16 KB, projection history 4 KB, audit 1 KB, transient row churn) | +16 to +21 GB → 50–55 GB; needs disk ≥ 80 GB or autoscaling; ceiling 58 GB |
| Post-publication catch-up | every published person carries a captured event; 2.1 people/s | ≈ 56 hours from an operator machine (round trip 44 ms); less from a machine in the database's region |
| Final audit | 3.8 people/s; startup ≈ 7 minutes | ≈ 31 hours from an operator machine |

The two long steps run with the controller open (the site works normally) and are resumable.
Their length is the main open question for the owner.

## 6. The production sequence (each step needs the written approval)

1. Owner checks: provisioned disk and PITR in the dashboard; fresh backup; Storage export
   (`export-storage-objects.sh`, read-only, verified).
2. Schema: `apply-upgrade.sh --dry-run`, then `apply-upgrade.sh`; then the label statement
   `select person_private.target_label('kmuihequfurvjxpnugxf')`. App still legacy.
3. Configuration: Vercel production and GitHub variables (`PERSON_TARGET_PROJECT_REF`,
   `PERSON_DATABASE_URL`, `PERSON_WRITE_MODE=legacy`, `PERSON_TRANSITION_SUPPORT=on`); deploy
   the branch; verify REST and PostgreSQL report the production label.
4. Settle the workers: no run in progress, schedules paused for the sitting.
5. Operator sequence through the transition CLI: arm → drain → seal → catch-up (held window) →
   reconcile finalizer → anchors → reopen → publication windows (≤ 720 min each, `--resume`,
   `vacuum candidates` between windows) → post-publication catch-up (held) → declared cutoff →
   final audit → audit finalizer.
6. Cutover: `PERSON_WRITE_MODE=live` for app and workers; re-enable schedules; merge PR #87 then
   PR #2 to `main`.

Rollback at any point: a failed migration leaves nothing of that version; a gate refusal keeps
legacy mode; a publication run is undone from its before-images after disarming the controller
(rehearsed: 486 restored, 0 conflicts); undone people need the legacy path to be republished.

## 7. Decisions only the owner can take

1. Disk and ceilings (58 GB ceiling, disk ≥ 80 GB or autoscaling); whether to fund the copy
   growing to finish its rehearsal, or delete it now.
2. Where the two long jobs run (operator machine vs a machine in the database's region) and
   acceptance of the reconcile finalizer's `review_required` outcome when the communications
   directory changes during a scan (it is written by other tools and will keep changing).
3. Rollback scope: an undo is an abandonment step; re-publication needs the controller disabled,
   or an armed-aware undo must be built first.
4. Review policy: 5,488 open identity conflicts over 9,352 people are skipped by default.
5. The uncommitted `package.json` `packageManager` line (pnpm without a lockfile): commit or drop.

## 8. Recommended order from here

1. Export the copy's rehearsal evidence (run tables, controller history; read-only, ~20 min),
   remove the preview's references to it, delete the copy. Stops the bill; blocks nothing.
2. Decide items 1–5 above.
3. Approve the package in writing; run steps 1–6 of section 6.
