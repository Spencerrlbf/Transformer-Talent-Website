# The review bucket: what publish carries forward, and how to work it

Written 2026-09-26 evening (UTC) from read-only queries against the website
project. Counts and ids only. Spencer's decision (2026-09-26): publish everyone,
including these people, and work the bucket after cutover. Nothing here changes
data; it is the worklist and the reasoning for the post-cutover review.

## Summary

| Bucket | Records | People affected | Publish behaviour | Post-cutover work |
|---|---|---|---|---|
| LinkedIn numeric id already owned by another candidate row | 3,954 | 3,954 incoming (3,935 owners) | profile published; the disputed id stays with the first-processed owner | deduplicate or correct the wrong id |
| LinkedIn username already owned by another row | 560 | 560 incoming | same | same |
| Airtable id already owned by another row | 1 | 1 | same | same |
| Email already owned by another row (normalized contacts) | 511 | 481 incoming | profile published; the contact is not attached | deduplicate |
| Job with no identifiable employer | 416 | 383 | job kept with an explicit Unknown employer | enrich or accept |
| Ambiguous job identity | 40 | 19 | history kept, no rekey | review |
| Ambiguous company identity | 1 | 1 | review, no merge | review |
| Directory snapshot changed after the copy (reconciliation "same snapshot mutation") | 85 | 85 | published from the copied facts | the pre-cutover directory catch-up re-admits them through receipts |
| Source-date holds (cached Harvest payload, fetch date unprovable) | 2 | 2 | not published | two fresh Harvest pulls after cutover |
| Legacy unique-email collision at publish time (from the preview) | 272 | 272 | today's address kept, `legacy_email_collision` review record | deduplicate |

Open `identity_conflicts` rows at the time of writing: 5,483. All are `open`.

## 1. LinkedIn numeric id collisions (3,954 pairs)

A pair is an incoming row whose LinkedIn numeric id (URN) was already registered
to another candidate row when the copy reached it. The writer never merges: the
incoming person's profile, jobs, education, skills and contacts are stored under
their own id; only the disputed identity row stays with the owner.

| Name comparison across the pair | Pairs | Both rows store that same id in their own LinkedIn data |
|---|---|---|
| Same full name | 1,661 | 1,239 |
| Same first name only | 280 | (in the 2,293 below) |
| Different name | 2,013 | 1,998 of the 2,293 non-identical-name pairs |

Reading: in 3,237 of the 3,954 pairs both people came from the legacy import
alone, and in 1,998 of the different-name pairs both candidate rows carry the
same numeric id inside their own stored LinkedIn JSON. A real LinkedIn numeric
id belongs to one profile, so one side of each such pair was imported with
another person's id. This is an old-import data defect the unification exposed;
it did not exist as a visible fact before. 3,947 pairs have two different vanity
URLs, so the URL is the better identity signal for these people.

Ownership today is "first processed wins" (candidate id order), not evidence
based. 87% of pairs involve two people neither of whom has ever been judged for a
role (`match_verdicts` empty on both sides), so most can be resolved without
touching verdicts.

Suggested handling, in order:
1. Same full name and same numeric id in both rows (1,239): almost certainly one
   person imported twice under two URL spellings. Candidates for a merge tool
   that keeps the row with verdicts or the older row, and re-points the other's
   identities and links. The writer has no merge path by design; this needs its
   own reviewed script.
2. Different name, same numeric id in both rows (1,998): one row's id is wrong.
   A fresh Harvest fetch by vanity URL for each side settles which; costs about
   4,000 pulls, so batch it behind the existing daily cap or sample first.
3. The remainder (about 700): the id came from one side only (directory or
   Harvest source). Review by hand from the pair list.

Pair list (ids only): `select incoming->>'incoming_candidate', incoming->>'owner',
incoming->>'identity_kind' from identity_conflicts where kind='identity_taken' and status='open'`.

## 2. LinkedIn username collisions (560 pairs)

The normalized username of the incoming person equals one already registered.
Only 5 pairs share the same `candidates.linkedin_url`; 4 share the same
`linkedin_username` column. The rest differ in the URL but normalize to the same
slug (case, trailing slash, encoded characters), or the legacy JSON carried a
different public identifier than the row's URL. 411 of 560 pairs are people from
different sources. Same first approach as above; expect more true duplicates here.

## 3. Email collisions (511 pairs, plus 272 at publish)

An incoming person's normalized contacts include an address already owned by
another candidate's contacts (511; 503 with exactly one other holder), or the
projected primary address is already in another row's `candidates.email` column
(272, found by the preview). Same full name on 189 of the 511 pairs. Email is
never an identity for admission, so none of these merged anyone. Work them with
the identity collisions; many pairs overlap.

## 4. Employer and job identity (383 + 19 + 1 people)

416 jobs (383 people) have a titled position whose source names no employer that
resolves to a company identity. They are stored with an explicit Unknown employer
placeholder and a `missing_employer` review record, so nothing was dropped or
guessed. 19 people have a job whose identity is ambiguous between existing rows;
1 has an ambiguous company. These publish as they are; enrichment or a manual
employer choice can follow.

## 5. Directory snapshot changed after the copy (85 people)

All 85 are `directory` people whose live directory record changed between the
baseline copy (05:48 to 17:04 UTC) and the reconciliation scan (17:34 to 19:51
UTC), with no newer dated fact to justify taking the new content. None of the 85
candidate rows changed and no capture event exists for them: the movement is on
the directory side only. This is directory drift, the class decision 10 covers.
The bounded directory catch-up before cutover, and live directory sync after,
re-admit them through receipts. Nothing to do by hand unless a receipt lands in
review.

Ids: `select candidate_id from person_reconcile_people where
run_id='person-reconcile-full-20260926' and status='review' and
checks->>'reason'='same_snapshot_mutation'`.

## 6. Source-date holds (2 people)

`0fa8967c-33dd-4846-a241-0b7934113bc3` and `188586c5-86c5-47c6-9275-35d776fc4cbc`.
Their only Harvest evidence is a cache-hit payload whose original fetch date
cannot be proven. Excluded from the copy and from publication; the writer
refuses updates to them until the hold is resolved. Resolution: one fresh Harvest
pull each after cutover (dated evidence), then resolve the hold with that
provenance, then publish them. Never clear the hold or accept the reuse date.

## Reproducing the counts

All queries are read-only against the website project. The classification
queries live in this session's ledger; the two above and the `identity_conflicts`
groupings by `kind` and `incoming->>'identity_kind'` reproduce every table here.
