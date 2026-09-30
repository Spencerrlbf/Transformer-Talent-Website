# Certified recruiter contact edits

Prepared only. Installing this schema, enabling transition support and releasing
application behavior require the separate owner-approved cutover.

With support on, the TT contact editor uses one transaction and one private work
receipt per request UUID. The server binds the authenticated actor, person and
cleaned contact. New edits require an open controller; held/draining returns the
existing temporary-unavailable HTTP 503. Support-on legacy TT mode refuses before
REST. Client organization applicant/source contact storage stays unchanged.

A completed retry validates its original input then returns current contact under
the candidate lock, even after a shadow/live mode change or a newer hold. It never
reapplies the edit. The original mode, timestamp, document and result remain
immutable. Unowned historical receipts are not adopted.

Shadow intentionally updates the requested legacy contact overlay as the existing
editor does, together with normalized evidence and primary choices. Live also
publishes the full current normalized profile, including facts staged by earlier
shadow refreshes. Notes, resume and unrelated workflow data remain unchanged.
Explicit null withdraws manual preference; removing curated other emails retains
their source evidence. Unusable contacts cannot become primary. Legacy unique-email
collisions retain the incumbent field and a review record without merging people.
No paid derivative/provider work is introduced here.

Run against isolated loopback PostgreSQL:

```
PSQL=/path/to/psql bash scripts/person-recruiter-admission/run-local-tests.sh PORT
```

The runner resets only `person_recruiter_admission_test`. Tests execute real SQL,
concurrent requests and lock waits, deliberately suppressed/corrupted writes,
partial commits, response loss, actual server helpers and the authenticated PUT
route. All REST/auth responses are synthetic loopback fixtures. The previous
refresh-save and directory-worker runners also load the new dispatchers; the latter
runs the application → directory → refresh → recruiter audit-chain regressions.
