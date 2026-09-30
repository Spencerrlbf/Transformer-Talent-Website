# TT applicant contact edits (Spencer, 2026-09-28)

With `PERSON_TRANSITION_SUPPORT=on`, for Transformer Talent application keys (`app_`):

| Applicant | Contact edit and resume contact fill | Drawer shows |
|---|---|---|
| Linked to a pool person | Contact edit: the pool person's contact, through the certified recruiter path (`saveRecruiterContact`). Resume fill: not written automatically (see below) | The pool person's published contact (or their row, if unpublished), and Send and the candidate list use the same address |
| Not linked | Contact edit: `person_application_edit(..., 'contact', ...)`. Resume fill: `person_application_contact_fill`, the old fill rule decided under the row lock | The application copy |

The application keeps its original submitted contact as the historical record, and
the audit compares it with the intake receipt. A linked row can never be edited by
the `contact` kind (`linked`). Tenant rows and support-off behavior are unchanged.

`20260928060000_person_application_contact.sql` adds the `contact` kind and its
shape check: email, phone, github, and up to 8 other emails. It lets the result and
intake guards accept only that exact edit frame.

**Deviation from the agreed wording: a linked applicant's resume fill is not written.**
The only write path for a pool person's contact is the recruiter path. It records
every value as the recruiter's own choice: it pins the primary and marks a parsed
phone as typed. It also writes the whole block, so it could revert a recruiter's
concurrent save. The pool person's contacts keep coming from their sources and
from recruiter edits.

If a linked person's pool read fails, the drawer refuses the read with a retryable
503 rather than offering an editable empty contact. The list and email recipient
remain empty; the submitted application address is never revived. Confirmed empty
contact remains empty. Unpublished people use the same verification-table email
selection as the pool drawer and Send. A row that becomes linked during an edit
returns `contact_moved`.

The linked resume-fill omission remains a release blocker, not an accepted scope
change. It needs a certified gap-fill operation that records extracted evidence
without changing recruiter choices or replacing a concurrent contact edit.

## Verification

- **Edit tests:** 40/40 including the shared suite. They cover atomic fill, phone
  extensions, and a real live drawer save through the certified recruiter
  transaction, including replay, audit verification, preserved submitted copy,
  and refusal while draining.
- **Recipient/read tests:** 13/13 with sealed external reads, covering absent or
  unavailable pool contact, verification-table selection, and tenant/support-off
  behavior. The stale-recipient, stale-display and resolver failures were
  reproduced before the fixes.
- **Route tests:** 18/18. A linked applicant's contact waits in legacy mode and never
  touches the application row. An unlinked applicant saves only through the checked edit.
- **Recruiter suites:** 23/23 and 77/77.
- **Other suites:** cross-family 504/504, publish 39/39, publish admission 11/11,
  maintenance 10/10 (current and pinned runner).
- **Type check:** `tsc` passes.

Hosted tenancy for the combined head remains pending. The prepared migration has
not been installed in production, and linked automatic resume fill is unfinished.
