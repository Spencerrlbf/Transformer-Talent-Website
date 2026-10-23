# TT applicant contact edits (Spencer, 2026-09-28)

With `PERSON_TRANSITION_SUPPORT=on`, for Transformer Talent application keys (`app_`):

| Applicant | Contact edit and resume contact fill | Drawer shows |
|---|---|---|
| Linked to a pool person | Contact edit: the pool person's contact, through the certified recruiter path (`saveRecruiterContact`). Resume fill: a distinct certified automatic gap-fill | The pool person's published contact (or their row, if unpublished), and Send and the candidate list use the same address |
| Not linked | Contact edit: `person_application_edit(..., 'contact', ...)`. Resume fill: `person_application_contact_fill`, the old fill rule decided under the row lock | The application copy |

The application keeps its original submitted contact as the historical record, and
the audit compares it with the intake receipt. A linked row can never be edited by
the `contact` kind (`linked`). Tenant rows and support-off behavior are unchanged.

`20260928060000_person_application_contact.sql` adds the `contact` kind and its
shape check: email, phone, github, and up to 8 other emails. It lets the result and
intake guards accept only that exact edit frame.

Linked resume uploads use `fillLinkedResumeContact` and prepared migration
`20260928061000_person_resume_contact_fill.sql`. A distinct, immutable binding
records the authenticated actor, current application/candidate link, uploaded
path/hash, extracted contacts and locked before-images. The existing certified
transaction performs normalization, attribution and projection atomically. The
source is `application` / `website-resume-upload`, with parser provenance;
extracted values are never labelled manual or verified.

Only new values fill gaps. Existing claimed, rejected and never-primary contacts
are not promoted. A recruiter phone choice, including an explicit clear, blocks
phone fill; the complete primary-choice snapshot stays unchanged. The existing
secondary list is retained when there is no curated overlay. New active email
values follow the normal ranking policy, so a newly selected primary is returned
to the drawer along with eligible phone/secondary changes. Public-form eligibility
rules are unchanged. A replay returns no new changes.

If a linked person's pool read fails, the drawer refuses the read with a retryable
503 rather than offering an editable empty contact. The list and email recipient
remain empty; the submitted application address is never revived. Confirmed empty
contact remains empty. Unpublished people use the same verification-table email
selection as the pool drawer and Send. A row that becomes linked during an edit
returns `contact_moved`.

## Verification

- **Edit tests:** 52/52 including shared intake tests, real live contact/save/upload
  routes, replay, concurrent recruiter writes, claimed contacts, explicit clears,
  stale uploads/linkage, tenant refusal, draining, null contact and secondary-list
  regressions, binding/document tampering, and independent audit reconstruction.
  PDF parsing and storage are sealed local fixtures; database transactions are real.
- **Recipient/read tests:** 13/13, with sealed external reads.
- **Route pause tests:** 18/18.
- **Cross-family regression:** 504 Node tests and 48 SQL checks on the combined
  prepared chain. Type and email escaping checks pass.

Independent review has no remaining Critical or Important findings. Exact-preview
hosted tenancy remains the integration gate.
Both prepared contact migrations remain uninstalled in production.
