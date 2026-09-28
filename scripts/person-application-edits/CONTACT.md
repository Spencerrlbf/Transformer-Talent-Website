# TT applicant contact edits (Spencer, 2026-09-28)

With `PERSON_TRANSITION_SUPPORT=on`, for Transformer Talent application keys (`app_`):

| Applicant | Contact edit and resume contact fill | Drawer shows |
|---|---|---|
| Linked to a pool person | The pool person's contact, through the certified recruiter path (`saveRecruiterContact`) | The pool person's published contact (or their row, if unpublished) |
| Not linked | The application's own copy, through `person_application_edit(..., 'contact', ...)` | The application copy |

The application keeps its original submitted contact as the historical record, and
the audit compares it with the intake receipt. A linked row can never be edited by
the `contact` kind (`linked`). Tenant rows and support-off behavior are unchanged.

`20260928060000_person_application_contact.sql` adds the `contact` kind and its
shape check: email, phone, github, and up to 8 other emails. It lets the result and
intake guards accept only that exact edit frame.

## Verification

- **Edit tests:** 35/35 including the shared suite.
- **Route tests:** 18/18. A linked applicant's contact waits in legacy mode and never
  touches the application row. An unlinked applicant saves only through the checked edit.
- **Recruiter suites:** 23/23 and 77/77.
- **Other suites:** cross-family 504/504, publish 39/39, publish admission 11/11,
  maintenance 10/10 (current and pinned runner).
- **Type check:** `tsc` passes.

Not tested end to end: a linked contact save in live mode through the drawer route.
The recruiter path it calls is covered by the recruiter suites.
