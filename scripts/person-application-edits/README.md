# Checked TT application edits

Prepared only. `20260928040000_person_application_edits.sql` adds
`person_application_edit(application, kind, patch, mirror)`. It is the only way to
change a Transformer Talent application row outside intake and completion once
the source fence is enforced.

| Kind | Application columns | Pool-person mirror |
|---|---|---|
| `followup` | follow_up_at, preferred_roles, preferred_locations, preferred_workplace, comp_expectation, visa_status, location | follow_up_at, role_preferences, visa_status |
| `followup_date` | follow_up_at | follow_up_at |
| `followup_clear` | follow_up_at (null) | follow_up_at |
| `resume` | resume_path and person_resume_sha256 (the new file's hash, both required) | none |
| `roles` | role_ids, role_titles (applicant add-role) | none |

Any other column, including contact and name, is refused, as is any value of the
wrong shape (dates, string lists, a dated upload path, a 64-character hash). The row and the mirror
are written in one transaction under exact before/after frames, and the actual
rows are read back.

- **Processing first.** An application accepted on the new path can be edited only
  after its processing has completed, because processing claims a frozen input that
  includes these columns. Rows accepted before the new path keep their current
  editability. Until then the function returns `processing`, which the routes
  report as a retryable 503.
- **Controller.** Edits are refused (`unavailable`) while the transition is draining
  or held, and allowed when open or disabled.
- **Lock order.** Controller, then the applicant's username (72007), then the
  application row, then the candidate row.
- **Latest intent.** The mirror updates the pool person only when this is the
  person's latest future-interest application (the pipeline's own rule). Editing an
  older application changes that row only.
- **Audit.** The mirror changes only non-profile columns. The post-cutover audit
  stays `verified` after every kind (tested).
- **Deploy order.** Install the migration before switching support on. Without the
  function, editors answer a retryable 503.
- **Scope.** Tenant rows are not admitted. Tenant editors keep their writers, as decided.

Website code uses the function whenever `PERSON_TRANSITION_SUPPORT=on` for TT rows:

- follow-up edit, reschedule and "Mark contacted";
- the drawer resume upload, with a readiness preflight before the file is stored;
- the public add-role.

With support off, the legacy writes are unchanged.

When an email send finds a due follow-up it cannot clear through the checked
edit, the follow-up stays due and is logged, instead of being marked handled
silently. With support off, the send behaves as before.

If the edit becomes unavailable between the resume preflight and the save, the
route deletes the just-uploaded file and returns a retryable 503.

Known limits:

- A new-path application that never completes processing stays uneditable. That
  covers input review, uncertain work, and rows whose status left the queue before
  a claim, so its follow-up can't be cleared. These applications already need review.
- Add-role requires completed processing. If processing is delayed past the
  one-hour add-role window, the applicant cannot add the role.

**Not in this change:**

- TT application contact edits, and the resume upload's contact fill for TT rows.
  These wait for Spencer's decision on where TT applicant contact edits belong.
- TT-target and client-target Send.

## Verification

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-application-edits/run-local-tests.sh PORT
```

On 2026-09-28:

- **Edit tests:** 11/11 on real processed applications, run with the shared
  application suite, 34/34 total.
- **Route tests:** `scripts/person-application-acceptance/test-pauses.mjs` 16/16, after an independent review.
- **Cross-family suite:** 504/504.
- **Type check:** `tsc --noEmit` passes.

`scripts/person-application-acceptance/run-local-tests.sh` has five failures that
predate this change. The same five fail on the unmodified parent `1c02b23`: that
harness does not install later migrations the library now uses. No production
database or hosted preview was used.
