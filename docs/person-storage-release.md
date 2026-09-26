# Candidate storage release prerequisites

The application feature stays off until Spencer approves the parent feature PR.
The overnight backfill only populates normalized storage; existing candidate
fields continue serving the deployed application.

## Atomic writer

`savePerson(doc, { mode: 'shadow' | 'live' })` uses one PostgreSQL connection for
source persistence, normalized reads, the existing TypeScript `project()` and
compatibility writes. Shadow mode never changes candidate profile fields.
Live mode records protected before-images and a semantic hash. Neither mode
calls paid providers or enqueues embedding/judging work.

Configure `PERSON_DATABASE_URL` with the **website project's** server-only
transaction-pooler connection before enabling the application writer. Never use
the communications database URL. The Node pool is limited to two connections per
process and does not use named prepared statements. Supply the pooler's verified
TLS configuration in the connection string; TLS verification is not disabled by
this module. Keep this secret out of browser/public environment variables.

Apply the reviewed additive `20260926033900_person_atomic_projection.sql` before
using live mode. It creates storage for projection hashes and before-images and
does not project any candidate automatically. This migration is prepared in the
feature branch; its presence in Git does not mean it has been applied live.

The writer preserves engagement/source labels, workflow state, notes, curated
contact visibility and existing computed experience fields. It uses the same
`project()` calculation and source precedence already exercised by the trial.
Absent lists retain existing columns; explicitly owned empty lists clear them.
A legacy unique email collision retains the old compatibility address and adds a
review item rather than merging people. Newer unprojected legacy changes fail
closed and must be reconciled.

`undoPersonProjectionOnConnection` restores only the profile fields in its
before-image, after checking both the normalized revision and the current
profile hash. Workflow changes are preserved. A newer profile edit, later
normalized revision or email uniqueness conflict prevents restoration. Source
records and normalized facts are retained.

Before release, complete source catch-up and writer integration, run the whole
branch tests and preview tenancy test, verify connection/configuration on the
approved deployment, then perform a bounded live canary. Do not enable the
restrictive legacy-write guard until every active writer supports this path.
