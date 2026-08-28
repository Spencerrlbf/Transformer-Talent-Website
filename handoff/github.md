repo: Spencerrlbf/Transformer-Talent-Website
branch: main

## Last sync

date: 2026-08-28T19:16:00Z

### Updated in this project

- New: `Agency Home.dc.html` — the chosen homepage direction (11a, two doors) built out with real placements from `data/placements.ts`, a how-it-works block and a market-index teaser.
- Grounded the public-site chrome across the homepage, roles and market-index files in `app/layout.tsx`: the `Transformer_Talent` wordmark, path-style nav, SYSTEM LIVE status and the real footer slogan. Dropped the invented “For companies” nav item and Privacy link.

- New: `Agency Homepage.dc.html` — three homepage layouts for transformertalent.com (Two doors, The ledger, Do it here) in the same language as the restyled roles and market-index pages, keeping the current hero claims verbatim.

- New: `Market Index.dc.html` — the index and a family guide, with SalaryChart redrawn for this system’s light palette (SF #5B4BFF / NYC #C4621B) and every band taken from the real `data/market-index.json` (123 searches).

- Rebuilt the `/apply` rail from `ApplyForm.tsx` proper: the two-panel Your application / Your details structure, slug-linked cart titles, and all six submit states (idle, sending, missing resume, network error, submitted, already applied).

- New: `Roles Public.dc.html` — the site’s own board in three linked views (roles index with selection rail, role detail with both fact tables and JD, and the apply page including the speculative variant), sharing one 3-role selection.

- New: `Network.dc.html` — the TT-only network matches table (person-first rows, matched-role chips, expandable per-role reviews, send-to-job confirm) plus every auth/access state DashShell renders: sign-in idle/sent/error, no-access, resolving, and wrong-org 404.
- Both new files carry a “For implementation” table mapping each visible state to its API response, so review-only switchers can’t be mistaken for UI to build.

- New: `Search Builder.dc.html` — the guided sourcing search: chip inputs, LinkedIn company typeahead, collapsible advanced filters, and all four preview outcomes (ready / not enough credits / too broad / no matches) with a live query + credit summary rail.

- New: `Public Board.dc.html` — the candidate-facing page in both modes (company board with Jobs/About tabs, recruiter page with the three doors and referral block), including the inline JD, 3-role APPLY + selection and the checkout rail.
- Candidates and Job Detail filters replaced with a single Filters menu + active-filter chips; the menu separates what `/candidates/v2` supports from proposed filters.

- Connected the repo and inventoried the real app: public site, recruiter/company dashboard, candidates pipeline, sourcing, market index.
- Confirmed dashboard nav from `DashShell.tsx` (Jobs · Candidates · My page · Settings, plus Network for TT-only and Team for owners).
- New: `Job Form.dc.html` — new/edit job with JD prefill, chip pickers for workplace/locations/visa, live validation minimums and the must-have skill matrix.
- Corrected My page's right-hand panel: `/r/[slug]` renders `BoardClient`, so the page summary + real OG link-card replaced the invented mini-page.
- New: `Settings.dc.html`, `Team.dc.html`, `My Page Editor.dc.html` — settings cards + StageEditor modal, team seats/invites/stats drawer, recruiter page settings with a live preview.
- Rebuilt Job Detail's Sourcing tab and Overview side cards from the real components (searches list → run workspace; ideal companies, interview stages, client link, sourcing help).
- New: `Job Detail.dc.html` — job workspace with live Overview / Pipeline / Sourcing / Past tabs and a Table ⇄ Board toggle; board expands “interviewing” into the job’s own stages.
- New: `Candidate Drawer.dc.html` — profile drawer over the pool table: live tabs, per-role pipeline rows with expandable client-safe fit reviews, resume and notes states.
- New: `Candidates.dc.html` — the unified applied + sourced pool table on the same shell, with fit tags, contact icons, follow-ups-due banner and pagination.
- New: `Dashboard Shell.dc.html` — dashboard frame (sidebar, top bar, page header, Jobs table) plus locked foundations, in the 1a visual direction.

## Screen map

| Project screen | Repo source |
| --- | --- |
| Hirepage Landing.dc.html (3 marketing directions) | app/page.tsx (marketing copy only — pre-repo, built from pasted content) |
| Dashboard Shell.dc.html → 2a shell + Jobs | components/dashboard/DashShell.tsx, app/dashboard/page.tsx, app/dashboard/settings/page.tsx (credits), app/globals.css (.dash-* rules) |
| Dashboard Shell.dc.html → 2b foundations | app/globals.css |
| Candidates.dc.html → 3a pool table | components/dashboard/candidates/CandidatesTable.tsx, app/dashboard/candidates/page.tsx, lib/server/dashboard-candidates.ts |
| Candidate Drawer.dc.html → 4a drawer | components/dashboard/candidates/CandidateDrawer.tsx |
| Settings.dc.html → 6a | app/dashboard/settings/page.tsx, components/dashboard/CompanyPageEditor.tsx, components/dashboard/jobs/StageEditor.tsx |
| Team.dc.html → 7a | app/dashboard/team/page.tsx |
| My Page Editor.dc.html → 8a | app/dashboard/my-page/page.tsx, app/r/[slug]/page.tsx, lib/server/recruiter-page.ts, app/r/[slug]/opengraph-image.tsx |
| Job Form.dc.html → 9a | components/dashboard/JobForm.tsx, lib/role-options.ts |
| Agency Home.dc.html (chosen: 11a) | app/page.tsx, app/layout.tsx, data/placements.ts, data/market-index.json |
| Agency Homepage.dc.html → 11a / 11b / 11c | app/page.tsx, data/placements.ts (not yet read), data/market-index.json |
| Market Index.dc.html → 10a index, family guide | app/market-index/page.tsx, app/market-index/[family]/page.tsx, components/SalaryChart.tsx, lib/market.ts, data/market-index.json |
| Roles Public.dc.html → 9a index / detail / apply | components/RolesTable.tsx, components/applySelection.ts, app/roles/page.tsx, app/roles/[slug]/page.tsx, app/apply/page.tsx, components/ApplyForm.tsx |
| Network.dc.html → 8a matches, 8b auth states | components/dashboard/network/NetworkTable.tsx, app/dashboard/network/page.tsx, components/dashboard/DashShell.tsx, lib/server/dashboard-auth.ts, app/api/dashboard/network/send/route.ts |
| Search Builder.dc.html → 7a | components/dashboard/sourcing/SearchBuilder.tsx, components/dashboard/sourcing/types.ts, app/api/dashboard/sourcing/preview/route.ts |
| Public Board.dc.html → 6a board + recruiter | components/board/BoardClient.tsx, components/board/CompanyAbout.tsx, app/board/[slug]/page.tsx, app/r/[slug]/page.tsx, lib/server/org-board.ts |
| Job Detail.dc.html → 5a job workspace | app/dashboard/jobs/[id]/page.tsx, components/dashboard/candidates/PipelineBoard.tsx, components/dashboard/jobs/IdealCompanies.tsx, InterviewStagesCard.tsx, ClientLinkCard.tsx, SourcingHelpCard.tsx, components/dashboard/sourcing/SourcingPanel.tsx, RunView.tsx, types.ts |
