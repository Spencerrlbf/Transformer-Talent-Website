# Network Send into the TT pipeline

With `PERSON_TRANSITION_SUPPORT=on`, a Network Send to one of Transformer Talent's
own roles creates the pipeline row through `person_network_send(row)`, from
`20260928070000_person_network_send.sql`.

- **What the row is.** The row is the one Send has always created: status
  `processed`, source `transformer_talent`, linked to the pool person, carrying the
  published profile snapshot, contact and TT's verdict.
- **Checks.** The function checks the columns and one target role. It waits while
  draining or held (`unavailable`). It decides `already_sent` under the applicant
  username lock, and inserts the exact row under a frame the TT source fence
  accepts.
- **Witness.** It records a private witness for the send. The post-cutover audit
  snapshot carries these witnesses (`application_sends`). The planner then treats a
  witnessed Send row as a pipeline entry, not a source: it is not pending, not a raw
  document, and not an integrity input. Without that rule, a sent person drops to
  `review: raw_fact_not_admitted` (tested).
- **Content bound to the pool record.** Name, LinkedIn URL and username, title,
  company and location must equal the pool person's own row, which the published
  profile is read from. The email must be one of the person's addresses, or empty.
  A service-role caller cannot plant a different identity or profile under a
  witness (`network_send_profile`). Contact phone, screening and the Harvest
  snapshot are still taken as given, as before the fence.
- **Locks.** The person's writer lock serializes concurrent Sends; every production
  candidate also has a username, so the username lock applies too. Refused rows
  report as failures (`insert_failed`), not as retryable.
- **Deploy order.** Install the migration before switching support on.
- **Client roles unchanged.** Sends into a client company's role create tenant rows,
  which the TT fence and the audit capture don't touch. They keep their writer.

## Verification (local, synthetic)

| Suite | Result |
|---|---|
| Edit suite, including Send: witness, audit stays `verified`, duplicate, concurrent Sends, draining, input and forged-content refusals, grants | 41/41 |
| Routes (a TT-target Send waits or saves only through the checked function) | 19/19 |
| Post-cutover audit suite, including the witness rule's edge cases | 91/91 |
| Cross-family | 504/504 |
| Publish | 39/39 |
| Publish admission | 11/11 |
| Maintenance, current and pinned runner | 10/10 each |
| Recruiter suites | 23/23 and 77/77 |
| `tsc` | passes |
