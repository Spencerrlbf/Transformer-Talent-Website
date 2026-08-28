# Design handoff — Transformer Talent

A complete visual redesign of `Spencerrlbf/Transformer-Talent-Website`, covering
both halves of the product: the recruiter/company **dashboard** (the SaaS
product) and the **public site** (transformertalent.com plus the tenant boards
and recruiter pages).

Fourteen screens across thirteen files. Every screen was designed from the real
source — component by component, keeping the data shapes, labels, states and
commercial rules that already exist. **This is a restyle and an
information-hierarchy pass, not a new feature set.** No schema, API or route
changes are required or intended. Where a design proposes something new, it is
called out explicitly (see *Additions to decide on*).

---

## 1. How to use this package

1. Unzip into the repo, e.g. `design_handoff/`, and commit it.
2. **Land `redesign.css` first.** It is the machine-readable half of this
   handoff: real CSS written against the class names your components already
   use (`dash-*`, `cv2-*`, `nw-*`, `dash-src-*`, `board-*`, `rp-*`, `coab-*`,
   and the public-site primitives). Append it to `app/globals.css` — later
   declarations win, so it takes over immediately — then delete superseded old
   blocks screen by screen as you verify them. Its header comments carry the
   full instructions, including the font swap in `app/layout.tsx`.
   The old dark-theme variables (`--fog`, `--signal`, `--panel`, `--line`) are
   re-pointed at the new palette in `:root`, so any rule you have not migrated
   yet renders in the new colours instead of fighting them.
3. Open each `.dc.html` in a browser. They are **interactive prototypes** — tabs,
   tables, drawers, filters, board drag targets and form states all work. Click
   things.
4. Read this README before writing code. `redesign.css` gives you the visual
   layer; this document gives you the structure, states and copy that CSS
   cannot express — which markup each rule expects, what each state means, and
   which API response drives it.

**Where the two disagree, `redesign.css` wins on values and this README wins on
structure.** The CSS was generated from the same mocks, so drift should be nil;
if you find any, the `2b Foundations` panel in `Dashboard Shell.dc.html` is the
tie-breaker.

### What `redesign.css` does not cover

- **Table column widths for real `<table>` elements.** The mocks use CSS grid;
  your tables are `<table>`. The per-screen `grid-template-columns` strings in
  §4 are the source of truth — translate them to `<col>` widths or `th` widths,
  or convert those tables to grid.
- **Markup that does not exist yet.** Some rules expect an element your
  components do not render today (the sidebar credits block, the filters menu,
  the pipeline tooltip, the two-door homepage). Those class names are namespaced
  and documented in §4; add the markup, and the styling is already there.
- **Components that did not change** (JobForm internals, StageEditor internals)
  beyond what the shared primitives in §2 give them.

**The `.dc.html` files are design references, not production code.** `support.js`
is the prototype runtime that makes them render and has no place in the app.
Do not port markup mechanically.

The task is to **recreate these designs inside the existing Next.js app** using
its own patterns: `"use client"` components under `components/`, class names in
`app/globals.css`, existing fetch/auth patterns (`useDash()`,
`Authorization: Bearer <token>`), existing API routes. Prefer editing
`globals.css` and existing components over introducing a CSS framework or a
component library.

**Fidelity: high.** Final colours, type scale, spacing, radii and states.
Recreate accurately. Every value is in *§3 Design system*; the on-screen
version of the same list is the `2b Foundations` panel in
`Dashboard Shell.dc.html`, which wins if the two ever disagree.

**Content is plausible sample data, not real records** — except where a section
below says copy is verbatim, and except the marketing placements, which are the
real five from `data/placements.ts`.

### Review-only controls — do not build these

Several files carry scaffolding so a reviewer can see every state without a live
API. Each is visually marked. Do not implement:

| File | Control |
| --- | --- |
| `Search Builder.dc.html` | the five preview-state pills (Building / Ready / Not enough credits / Too broad / No matches) |
| `Roles Public.dc.html` | the "Review only — rail states" chips in the apply rail |
| `Roles Public.dc.html`, `Public Board.dc.html`, `Market Index.dc.html` | the view switcher above the page (Index / Detail / Apply etc.) — these are separate routes |
| `Public Board.dc.html` | the Company board / Recruiter page mode toggle — these are separate routes |
| `Job Detail.dc.html` | the `client view` dashed marker on the Sourcing help card |
| `Agency Home.dc.html` | the amber "new section — confirm the copy" flag on *How it works* |
| all files | the `1a`/`2a`/`9a` id badges and the grey caption lines |

---

## 2. Global structure

### 2.1 Dashboard shell — replaces `DashShell`

Two columns, no page-level scroll container beyond the main region. Desktop
only, ≥1280px.

**Sidebar** — 236px fixed, `background #FBFAF8`, `border-right 1px solid
rgba(0,0,0,.08)`, padding `18px 14px`, flex column.

- Org block: 30×30 tile, `radius 9px`, `background #111110`, white 13px/700
  initials; org name 13.5px/600; `board/<slug>` 11.5px `#8A877F` beneath. Both
  truncate.
- Nav rows: 34px, `padding 0 10px`, `radius 8px`, label 13.5px/500 `#5D5B56`.
  **No icons** — label plus a right-aligned count or badge. Active:
  `background #EFEDFF`, text `#111110`, weight 600, count `#5B4BFF`. Hover:
  `background rgba(0,0,0,.04)`. Sub-items (Network, Team) indent to
  `padding-left 22px`.
  Order and visibility exactly as `DashShell.tsx`: Jobs, Candidates,
  (Network — TT org only, `TT` outline badge), My page (`set up` pill until
  published), (Team — owners only), Settings.
- **Sourcing credits block** — *new placement*, currently in Settings: hairline
  top border, 11px uppercase label, 19px/600 tabular value, 4px progress bar
  (`#5B4BFF` on `rgba(0,0,0,.08)`), 11.5px note "180 reserved by 2 runs in
  progress".
- Footer, `margin-top:auto`: 26px avatar `#EFEDFF`/`#4536E8`, email 12.5px
  truncating, role 11px `#8A877F`, 12px Sign out.

**Top bar** — 56px, `border-bottom 1px solid rgba(0,0,0,.08)`, `padding 0 32px`:
breadcrumb (`Org / Page`, 13px, separator `#C2BFB8`, current page `#111110`
500), spacer, a 32px ⌘K search field (260px, `radius 8px`, keycap in a 1px box),
and one contextual secondary action.

**Page body** — `padding 26px 32px 40px`. Title 27px/600 `letter-spacing -.025em`;
sub-line 13.5px `#8A877F` with tabular figures; primary action right-aligned on
the title row.

### 2.2 Public site chrome — from `app/layout.tsx`

Used by the homepage, `/roles`, `/apply` and `/market-index`. Grounded in the
real layout, restyled:

- Brand is the wordmark **`Transformer_Talent`** — the underscore is `#5B4BFF`,
  the rest `#111110`. Not the plain words.
- Nav keeps the path-style convention: `/about` · `/market-index` · `/roles`,
  then `UPLOAD JD →` as a filled 34px pill (11px/700, `letter-spacing .07em`).
- `SYSTEM LIVE` status at the right: 10.5px/700 `#1F7A4C` with a 6px dot.
- Footer: `© 2026 TRANSFORMER TALENT — "TALENT IS ALL YOU NEED"` (11px/600,
  `letter-spacing .1em`, `#8A877F`) with `spencer@transformertalent.com`
  right-aligned.
- **There is no "For companies" nav item and no Privacy link** — earlier drafts
  invented both; they are removed. Add them only if you actually build those
  routes.

### 2.3 One filter pattern, everywhere

All four dense tables (dashboard Candidates, job Pipeline, Network, public
boards) use the same control, replacing the current rows of bare selects:

- A **`Filters`** button — 36px, `radius 8px`, label 13.5px/600, with a count
  badge (18px pill, `#5B4BFF`, white tabular figure) when filters are active
  and a `▾`. Active/open state: `border rgba(91,75,255,.45)`,
  `background #F6F4FF`.
- Clicking opens a **grouped menu** (288px, `radius 12px`,
  `box-shadow 0 22px 54px -24px rgba(17,17,16,.45)`): an "Add filter…" header
  row, then group headings (11px/600 uppercase `#A9A6A0`) over 34px rows —
  icon slot, label, current value right-aligned in `#4536E8`, chevron.
- **Active filters appear as chips below the row**: 30px, `radius 8px`,
  `border rgba(91,75,255,.32)`, `background #F6F4FF`, text `#4536E8` with the
  value in 600 and an `×`. Then a **Clear all** text button.
- The search field fills the remaining width; the sort label sits at the end of
  the *search* row, never in the chips row.

On the dashboard Candidates menu, only filters the API actually supports are
live (Role, Fit, Source, Follow-ups, "Not now"). Everything else is greyed with
a `soon` tag and a note that each needs a new query param on `/candidates/v2`.
Keep that distinction — it is how the pattern stays honest.

---

## 3. Design system

### Colour

| Token | Value |
| --- | --- |
| Ink | `#111110` |
| Body | `#3B3934` / `#5D5B56` |
| Muted | `#8A877F` |
| Faint | `#C2BFB8` |
| Disabled text | `#A9A6A0` |
| Surface | `#FBFAF8` |
| Accent surface | `#FBFAFF` |
| Page (public) | `#F4F2EE` |
| Accent | `#5B4BFF` |
| Accent pressed | `#4536E8` |
| Accent wash | `#EFEDFF` |
| Accent tint | `#F6F4FF` |
| Positive | `#1F7A4C` on `#E9F5EE` |
| Attention | `#9A5B14` on `#FBF1E6` |
| Destructive | `#B3402F` on `#FBEAE7` |

Pipeline stages: Screening `#5B4BFF` · Replied `#9C93FF` · Interview `#C9C4FF` ·
Offer `#1F7A4C` · Not contacted `rgba(0,0,0,.09)`.

Borders: hairline `rgba(0,0,0,.08)`, control `rgba(0,0,0,.12)`, table divider
`rgba(0,0,0,.07)`, strong `rgba(0,0,0,.22)`.

Avatar palette — hash the name, as `CandidatesTable.tsx` already does:
`#5B7FDB #4CA88C #C4736B #8A6FC2 #C99242 #5E9DB8 #7A8699`.

Market-index series: **SF `#5B4BFF`**, **NYC `#C4621B`** (replaces the old
orange/cyan pair; hue-distinct so it survives colour-blind viewing and
greyscale printing). LinkedIn brand `#0A66C2`; contact icon stroke `#4A5160`,
empty `#D3D7DD`.

### Typography

**Instrument Sans** (Google Fonts, 400–700), with **Instrument Serif** italic
used sparingly — one accent word in a headline, or a hint line. This replaces
Archivo + IBM Plex Mono.
`font-variant-numeric: tabular-nums` on every number, salary, date and count.

| Role | Size / weight |
| --- | --- |
| Marketing hero | 50–62 / 600 / `-.035em` |
| Page title | 27 / 600 / `-.025em` |
| Section heading | 19 / 600 / `-.02em` |
| Card heading | 17 / 600 / `-.02em` |
| Row name, emphasis | 14.5 / 600 / `-.01em` |
| Body, cell | 13.5–14 / 400 (prose 14–15 / 1.65) |
| Meta, timestamp | 12 / 400 `#8A877F` |
| Column + section label | 11 / 600 / `.07em` / uppercase `#8A877F` |
| Pills | 11.5–12.5 / 600 |
| Micro label (uppercase) | 10.5 / 700 / `.09em` |

### Spacing, radius, elevation

Page gutter 32 (public 34), page top 26, card padding 16–22, table row padding
13–15 / 18–20, grid gaps 10–16, stack gaps 7–14.

Radius: 8 controls · 10 small cards, board cards · 12 tooltips, menus,
dropzones · 14 panels and tables (inner header 13) · 16 page shells and modals ·
999 pills and avatars.

Elevation — almost none. The exceptions: drawer
`-24px 0 60px -30px rgba(17,17,16,.5)`; modal `0 30px 70px -24px rgba(17,17,16,.5)`;
menu `0 22px 54px -24px rgba(17,17,16,.45)`; tooltip `0 14px 34px rgba(0,0,0,.3)`;
active segment chip `0 1px 3px rgba(0,0,0,.14)`; dragging board card
`0 6px 18px -8px rgba(17,17,16,.35)`.

Control heights — 44 marketing CTA · 40 full-width submit · 38 primary form ·
36 primary/secondary · 34 nav rows, top-bar buttons, inputs · 30 pills and row
buttons · 28 in-table chips · 26 chip inputs · 17 switch track.

---

## 4. The screens

### 4.1 `Dashboard Shell.dc.html` — shell + Jobs list (`2a`), Foundations (`2b`)
Source: `DashShell.tsx`, `app/dashboard/page.tsx`.

Title "Jobs", sub-line `6 open · 3 closed · 418 people in the pool`. Actions:
"Import a JD" (secondary), "New job" (primary).

- **Client-requests banner** (`ClientRequestsBlock`): `radius 14px`,
  `background #FBFAFF`, hairline; 32px count tile `#EFEDFF`/`#4536E8`; title
  14px/600, detail 13px `#5D5B56`; accent "Review" pill.
- **Filter pills**: 30px, `radius 999px`. Active `#111110`/white with the count
  at 55% opacity; inactive hairline, text `#5D5B56`. Open / Closed / Linked to
  a client. Right: "Sorted by newest activity".
- **Pipeline legend** (*new*): swatch + label per stage, then an italic serif
  hint "hover a bar for the counts".
- **Table**: one wrapper, `radius 14px`, hairline, `overflow: visible` (tooltips
  escape it) with the header rounded `13px 13px 0 0`. Header `padding 11px 20px`,
  `background #FBFAF8`. Rows `padding 15px 20px`, divider
  `1px solid rgba(0,0,0,.07)`, hover `#FBFAF8`.
  Grid — identical on the header, every open row and every closed row:
  `grid-template-columns: 2.4fr 1.4fr 1.2fr .7fr .9fr 1.5fr; gap: 16px`
  → Role · Locations · Salary · Years · Applicants (right) · Pipeline.
  Role cell: title 14.5px/600 with an optional `linked` pill
  (`#EFEDFF`/`#4536E8`), meta 12px `#8A877F` tabular `#1042 · Hybrid · Northline
  Search`.
- **Pipeline bar**: 6px, `radius 999px`, track `rgba(0,0,0,.09)`, segments in
  legend order; trailing 12px `#8A877F` label naming the furthest stage reached
  ("3 at offer", "sourcing", "new"). **Hover** shows a tooltip: `#111110`, white
  text, `radius 12px`, `padding 13px 15px`, `width 244px`, 10px clear of the bar,
  right-aligned; "<total> candidates · <role>" then a swatch/label/count line per
  stage, with "Not contacted yet" after a `rgba(255,255,255,.14)` divider. Rows
  in the lower half flip it above (`bottom: calc(100% + 10px)`).
- **Closed section**: uppercase label, rows on the **same six-column grid**, all
  text `#8A877F`, name `#5D5B56`, last cell "Filled 12 Aug".

### 4.2 `Candidates.dc.html` — unified pool (`3a`)
Source: `CandidatesTable.tsx`, `app/dashboard/candidates/page.tsx`.

Sub-line verbatim: `418 people across all roles · 236 applied · 182 sourced ·
24 tagged "Not now"`. Primary action "Start a sourcing run"; top-bar action
"Export CSV".

- **Follow-ups-due banner**: `background #FBF1E6`, `radius 14px`; bold count
  `#9A5B14`; named people 13px `#584634`; "View" pill `#9A5B14`/white.
- Filter row: the standard Filters menu + chips, plus the All / Applied /
  Sourced / Follow-ups scope as a segmented control (3px inset track
  `rgba(0,0,0,.05)`, active chip white).
- **Table grid** — elastic columns are `fr`, every label column is a fixed px
  track so sibling row-grids resolve identically:
  `minmax(0,2.4fr) 64px 152px minmax(0,3fr) 26px 58px 106px 58px; gap: 14px`
  → Candidate · Source · Fit · Current role · LinkedIn · Contact · Reach out ·
  Added (right).
- Candidate cell: 30px hashed avatar, name 14.5px/600, optional `Via TT` pill
  **inline after the name** — never a second line.
- Source: 7px dot + label. Applied `#5B4BFF`, Sourced `#9C93FF`.
- **Fit pill** — 11.5px/600, `radius 999px`, `padding 3px 10px`,
  `white-space: nowrap`, `justify-self: start`. Vocabulary and colours:
  Strong `#1F7A4C`/`#E9F5EE` · Yes `#4536E8`/`#EFEDFF` · Worth a look / Worth a
  message / Likely a stretch / No role match `#5D5B56`/`rgba(0,0,0,.06)` ·
  Not now `#9A5B14`/`#FBF1E6` · Screening… `#8A877F`/`rgba(0,0,0,.045)`.
- Current role: title 14px/500 plus 12px `#8A877F` meta `Company · Location`
  (both folded in from their own columns).
- LinkedIn: the repo's 16px glyph, 30% opacity when absent. Contact: 15px mail +
  phone outline icons; clicking copies and shows "Copied ✓" for 1.4s.
- Reach out: `Due · Aug 2026` 12.5px/600 `#9A5B14` when due, plain `#5D5B56`
  when future, `—` `#C2BFB8` when unset. Always `nowrap`.
- Footer: "Showing 1–10 of 418" left; 30px square pager and "Page 1 of 42" right.
- Keep the caption under the table — it encodes the commercial rule: fit tags
  come from screening and stay client-safe, a tag and a plain-English reason,
  never the underlying scorecard.

### 4.3 `Candidate Drawer.dc.html` — profile drawer (`4a`)
Source: `CandidateDrawer.tsx`.

Overlay `rgba(17,17,16,.32)`; panel pinned right, **760px**, `border-left 1px
solid rgba(0,0,0,.1)`, `box-shadow -24px 0 60px -30px rgba(17,17,16,.5)`. Fixed
header region, scrolling body. Esc closes (nested job panel first). Close
control: 30px square, `radius 8px`, hairline, top-right.

- **Header**: 64px avatar; name 22px/600; best-fit pill; `Via TT` pill; headline
  14.5px `#3B3934`; "…at <Company> · <Location>" 13px `#8A877F`; links row —
  `LinkedIn ↗` (`#4536E8` 600), source dot+label, "also in your sourcing runs".
- **Contact row**: values in 28px hairline boxes; missing fields as dashed
  `+ Add GitHub` in `#5B4BFF`; a text `Edit` swaps the row for four inputs +
  Save/Cancel.
- **Provenance strip**: `#FBFAF8`, hairline, `radius 10px`, 12.5px `#5D5B56`.
- **"Their ask" block** (only when a follow-up exists): `#FBF1E6`; uppercase
  11px `#9A5B14` label; "Reach out **August 2026 (due)** about <roles> ·
  <workplace> · <locations> · <salary>"; "Mark contacted" pill → replaced by
  "Contacted ✓ — follow-up cleared. They stay in your candidates."
- **Tabs**: Profile · Pipeline (count) · Resume · Notes. 13.5px,
  `padding 0 14px 11px`, active `#111110` 600 with a 2px underline on a shared
  `1px rgba(0,0,0,.08)` rule.
- **Profile**: About (14px/1.6); Experience grouped by employer — 40px logo tile,
  company 15px/600 linked + ` · 4 yrs 2 mos`, roles indented behind a
  `padding-left 14px; border-left 1px solid rgba(0,0,0,.1)` rail; Education row;
  Skills as `rgba(0,0,0,.05)` pills with `+12 more`.
- **Pipeline**: lead line explaining reviews are role-scoped and client-safe.
  One row per attached role on
  `minmax(0,1fr) 78px 152px 108px 22px; gap: 12px` → Role · Added (right) · Fit ·
  Stage · caret. Role cell: title 14.5px/600 with `#1042` in 400 `#8A877F`, meta
  12px `applied · Northline Search · £95k–£120k · London`. Stage is a 28px
  hairline dropdown chip (New / Contacted / Replied / Interviewing / Offer /
  Hired / Rejected). Clicking the row expands a `#FBFAF8` panel: the reason, a
  white "Worth asking about" card of probes, and a `#4536E8` 600 route line
  prefixed `↪`. Rejecting moves the person to that job's Past tab.
- **Resume**: file bar (red `PDF` chip, name, "Uploaded 19 Aug · 218 KB",
  "Re-upload"), 520px inline preview, hint "PDF only, up to 8 MB". Empty state
  is a dashed dropzone.
- **Notes**: disabled textarea + "Notes are coming soon — they'll be shared with
  your teammates and kept alongside the candidate."

### 4.4 `Job Detail.dc.html` — job workspace (`5a`)
Source: `app/dashboard/jobs/[id]/page.tsx`, `PipelineBoard.tsx`,
`components/dashboard/jobs/*`, `components/dashboard/sourcing/*`.

Header: title 27px/600 + status pill (`Open` = `#1F7A4C`/`#E9F5EE`, 11px/600
uppercase) + `linked · <client>` pill; meta `#1042 · Hybrid · London ·
£95,000–£120,000 + equity · 5–8 yrs`; actions Edit / Close job. Tabs
Overview · Pipeline (count) · Sourcing · Past, deep-linked via `?tab=`; pipeline
view via `?view=board`.

**Overview** — `minmax(0,1.55fr) minmax(0,1fr); gap: 36px`. Left: About
14.5px/1.65, then Responsibilities / Requirements / Nice to have / Visa as
`—`-prefixed rows (`gap 9px`, dash `#C2BFB8`). Right rail, one card each
(`radius 14px`, hairline, `padding 16px 18px`):

- **Company** — inline-saving field + `Saved ✓` `#1F7A4C`; hint "Shown with this
  role in candidate profiles."
- **Ideal companies** — chip picker with 18px logo tiles and an "Add another…"
  input. Hint verbatim: "Companies whose engineers would be a great fit. The AI
  review treats experience at these companies as strong evidence when judging
  candidates for this role."
- **Interview stages** — `Custom` / `Company default` badge, numbered list,
  "Edit stages" opening the shared StageEditor.
- **Client link** (TT orgs) — `TT` lock badge, "Linked to **Northline Search** ·
  Senior Backend Engineer #NL-88", note about network sends, Change / Unlink.
- **Sourcing help** (client orgs — the alternate to Client link) — "Want help
  filling this role?", the consent note, "Ask Transformer Talent to help"; when
  on: "● Transformer Talent is helping fill this role."
- **Skills** — must-haves as filled `#EFEDFF` pills, others `rgba(0,0,0,.05)`,
  alternates as `+2 alt`.

**Pipeline** — count strip (`#FBFAF8`, `radius 14px`): `34 candidates ·
21 applied · 13 sourced · 4 "Not now" hidden · 6 rejected → Past`, with
right-aligned "9 network matches →" and "View sourcing runs →". Then the
Table / Board segmented control and the standard filter row.

- *Table*: `minmax(0,2.3fr) 64px 152px 138px minmax(0,2.2fr) 58px; gap: 14px`
  → Candidate · Source · Fit · **Stage** · Current role · Added.
- *Board* (`PipelineBoard`): horizontally scrollable, 196px columns, `gap 12px`.
  Fixed columns New / Contacted / Replied … Offer / Hired on `#FBFAF8`; the
  `interviewing` status expands into the job's configured stages, tinted
  `#F6F4FF` with `1px solid rgba(91,75,255,.22)` and a 9.5px/700
  `INTERVIEWING · n/4` kicker in `#4536E8`. Cards: white, `radius 10px`,
  hairline, `padding 10px` — 22px avatar, name 13px/600, `✕` reject,
  `title @ company` 11.5px, fit pill + days-in-stage (`<1d`, `2d`). Empty
  column: "No one here yet" `#A9A6A0`. Drag between columns; while dragging, a
  dashed full-width strip appears — "Drag a card here to reject → moves to the
  Past tab, restorable" — with a confirm step on the card.
- **Sourcing** — list → run, as `SourcingPanel` composes them. *List*:
  "3 searches for this job", `Credits: 2,140`, "New search"; rows of date/time ·
  `summarizeParams` summary · "184 imported · 120 reviewed · 12 already in pool" ·
  status pill using the real labels (`previewed`→Queued, `importing`→Importing…,
  `ranking`→Ranking…, `screening`→Reviewing…, `done`→Done, `failed`→Failed,
  `cancelled`→Cancelled). Empty-state copy is in `SourcingPanel.tsx` — verbatim.
  *Run* (`RunView`): "← All searches" / "Duplicate search", the summary, an
  active-progress card ("Reviewing every candidate… 120 of 180", "12 already in
  your pool (free) · started 8:02 am", 5px bar), filter chips All / Strong yes /
  Yes / Worth a message / Shortlisted ★, then the ranked table
  `44px minmax(0,2.1fr) minmax(0,2.1fr) 96px 72px` → rank · candidate (name,
  `title · company · location`, snapshot `9 yrs · prev: … · skills +14`) ·
  review (tag + reason) · LinkedIn ↗ · ★ / ✕. Footer "Showing 1–4 of 120 ·
  ranked best match first".
- **Past** — lead copy verbatim: "Candidates you rejected on this role. Profiles
  and reviews are kept — restore anyone to put them back in the active
  pipeline." Table `minmax(0,2.3fr) 64px 152px minmax(0,2.2fr) 92px 110px` →
  Candidate · Source · Fit · Current role · Rejected (right) · `↩ Restore`.

### 4.5 `Search Builder.dc.html` — guided sourcing search (`7a`)
Source: `SearchBuilder.tsx`, `sourcing/types.ts`,
`app/api/dashboard/sourcing/preview/route.ts`.

One card, fields in this order: **Job titles** (chip input) · **Locations**
(chip input) · **Ideal companies — currently there** (company typeahead) ·
**Ideal companies — worked there before** · **Keywords** (free text), then a
collapsible **More filters** block: Years of experience (5 bands), Company size
(8 headcounts), Schools, Exclude companies, Exclude locations.

- Chip inputs: 26px chips in a hairline box, `radius 8px`, Enter or comma
  commits, Backspace on empty removes the last.
- Company typeahead: `GET /sourcing/companies?q=`, debounced 300ms at 2+
  characters; results show a 28px logo tile, name, and `location · followers`.
  Store the LinkedIn URL as the value, the display name in `companyLabels`.
  Picked chips are `#EFEDFF`/`#3B2FB8` with a logo tile; exclusions are
  `#FBF1E6`/`#9A5B14`.
- Your own company is excluded by default — say so in the hint.
- Actions: **Preview matches** (primary) / Cancel, with the dirty note
  "No count yet — preview before importing".

**The preview is the guardrail.** No run can start without a count, and any edit
to any field resets it. States:

| State | API | Renders |
| --- | --- | --- |
| Building | no request yet, or any field edited | form only, no start button |
| Checking… | in flight | button disabled, label "Checking…" |
| Ready to import | `ok: true`, `creditsAvailable ≥ total` | green banner + "Import all N" → `POST /sourcing/runs` with `matchEstimate`, then route to the run |
| Not enough credits | `ok: true`, `creditsAvailable < total`, or **402** from `/sourcing/runs` (use `available`) | amber banner, no start button |
| Too broad | `code: "too_broad"` | amber banner, hard stop above `maxImport` |
| No matches | `code: "no_matches"` | neutral banner |
| Error | non-2xx or network failure | neutral banner, "The preview couldn't run. Try again in a moment." |

Reuse `QueryDraft`, `queryFromDraft`, `draftFromParams`, `summarizeParams` from
`types.ts` rather than re-deriving them.

*Additions:* a right rail with the live query summary and credit math,
"balance after this run" on the ready state, and three one-tap narrowing
suggestions on the too-broad state.

### 4.6 `Network.dc.html` — network matches (`8a`), auth states (`8b`)
Source: `NetworkTable.tsx`, `app/dashboard/network/page.tsx`, `DashShell.tsx`,
`dashboard-auth.ts`.

**8a** — TT-only. Title with an `Internal — clients never see this` badge
(`#FBF1E6`/`#9A5B14`) and the verbatim lead paragraph. Top bar carries
"● 7 new since yesterday" in `#1F7A4C`.

Person-first: one row per person with every role they matched, so nobody clicks
through 96 jobs to find the same engineer three times. Grid
`minmax(0,1.9fr) 130px minmax(0,2.2fr) 76px 44px 24px; gap: 14px` → Candidate ·
Location · Matched roles · Latest (right) · LinkedIn · caret. Candidate cell
folds `title @ company` into the meta line; a 6px `#1F7A4C` dot marks a match
added since yesterday.

Matched-role chips: 24px, `radius 6px`, `inset 2px 0 0 <stage colour>`, showing
`● Title #id`; already-sent chips are `#E9F5EE`/`#1F7A4C` with a tick; collapsed
rows cap at three plus a dashed `+N more`.

Expanding a row reveals one review block per role — role + fit tag, meta
`#id · company · salary`, a `→ delivers to <client>` line where relevant, the
client-safe reason, then **Send to job** / View job. Strong-fit blocks carry
`inset 3px 0 0 #1F7A4C`.

**Send** opens a 520px modal: "Send <First> to <Role>?", the delivery sentence,
a person card with the fit tag, then three `—` bullets (⚡ Via Transformer
Talent and the referral credit; built from the pool profile; starts at stage
**New**). `POST /network/send` with `{candidateId, jobId}`; treat **409** as
already-sent and mark it locally. Fetch failure renders "Couldn't load network
matches — refresh to retry."

**8b** — every state before the dashboard exists, all copy verbatim from
`DashShell`:

| State | Condition |
| --- | --- |
| Resolving session | `session === undefined`, or `/dashboard/me` in flight → "Loading…" centred |
| Sign in — idle | `!session`; `signInWithOtp`, redirect `/dashboard` |
| Sign in — link sent | "Check your email — we sent a sign-in link to **<email>**. The link works once and expires in an hour." |
| Sign in — send failed | "Couldn't send the link — wait a minute and try again." |
| No dashboard access | `session && !me` — includes the contact address |
| Page not found | `org.slug !== "transformer-talent"` for Network; `memberRole !== "owner"` for Team. Nav hides the item and the API 404s separately |

*Additions:* an "Access is granted by your admin" line and a "Start again" link
on the sign-in card.

### 4.7 `Job Form.dc.html`, `Settings.dc.html`, `Team.dc.html`, `My Page Editor.dc.html`
Sources: `JobForm.tsx` + `lib/role-options.ts`; `app/dashboard/settings/page.tsx`
+ `CompanyPageEditor.tsx` + `StageEditor.tsx`; `app/dashboard/team/page.tsx`;
`app/dashboard/my-page/page.tsx` + `recruiter-page.ts` + `opengraph-image.tsx`.

These follow the shell and token rules above with no new patterns. Points worth
keeping:

- **Job form** — JD paste/upload prefills the fields; chip pickers for
  workplace, locations and visa; live validation minimums; the must-have skill
  matrix. Same form for new and edit.
- **Settings** — cards per concern; the StageEditor opens as a modal and is
  shared with the job workspace.
- **Team** — seats, invites and roles, with a per-member stats drawer. Owner-only.
- **My page** — recruiter page settings with a live preview panel; the right-hand
  panel is the page summary plus the real OG link-card, because `/r/[slug]`
  renders `BoardClient` rather than a bespoke mini-page.

### 4.8 `Public Board.dc.html` — tenant board and recruiter page (`6a`)
Source: `BoardClient.tsx`, `CompanyAbout.tsx`, `app/board/[slug]/page.tsx`,
`app/r/[slug]/page.tsx`, `org-board.ts`.

**One component, two routes.** `/board/[slug]` adds the company identity strip
and the Jobs / About tabs; `/r/[slug]` swaps in the person header, makes a
resume mandatory, and adds the three doors and the referral block.

- **Identity strip**: 52px logo tile (letter fallback), name 23px/600, tagline
  14.5px, then facts as `rgba(0,0,0,.05)` pills (headcount, founded, stage,
  funding, offices, work environment — each only when present), website link
  right. Tabs below: `Jobs <n>` / `About`, `?tab=about` synced via
  `history.replaceState`.
- **Recruiter header**: 76px round avatar, name 25px/600,
  "Recruiter · **<Org>**", bio, then Book a call (primary) / Email / LinkedIn.
  Right: website and `<n> OPEN ROLES`. Booking opens the known-scheduler embed
  in an overlay, otherwise a new tab. Email copies and swaps to "Copied ✓".
- **Roles table**: `56px minmax(180px,2.6fr) 150px 120px 96px; gap: 14px` →
  ID · Role · Location · Base salary · Apply, inside a horizontal scroller with
  a **700px floor**. Workplace and experience fold into the role's meta line.
  Clicking the title expands the full JD inline (chips, about, What you'll do /
  What they're looking for / Nice to have, then APPLY + and close).
- **APPLY +** toggles selection, capped at **3**, labelled `✓ n/3` when selected.
- **Checkout rail** (352px, sticky) appears beside the table on selection: cart
  header (`n/3 ROLES SELECTED` or `GENERAL APPLICATION`), role cards with `✕`, a
  dashed slots note, then Your details — Name, Email, LinkedIn (required),
  Resume (required on recruiter pages and general applications), Locations,
  Visa, Anything else. Submit label switches between
  `SUBMIT — n ROLES →` / `SUBMIT FOR MATCHING →` / `SUBMITTING & MATCHING…`.
  On success the rail is replaced by the thank-you, whose four variants are in
  `BoardClient` (already applied / recruiter / speculative / normal) plus the
  "You also look like a fit for" list on org boards.
- **Three doors** (recruiter pages): UPLOAD RESUME → · HEAR FROM <FIRST> LATER ·
  REFER AN ENGINEER →. The middle one expands the future-interest form (email,
  LinkedIn, optional resume, 3/6/9/12-month pills, role focus / workplace /
  location / salary / visa preferences, and the "Nothing before then. No
  newsletter, no spam, one recruiter." fine print).
- **Referral block**: `#F4FAF6` with `rgba(31,122,76,.28)` border, the bounty
  sentence, four fields, `SEND REFERRAL →` in `#1F7A4C`. Generic thank-you
  either way — never reveal whether the person is already known.
- **About tab** (`CompanyAbout`): mission eyebrow + 26px lead + detail;
  free-form sections; founders with 56px avatars and LinkedIn links; "How we
  hire" with numbered `<details>` rounds (name, hint, duration, click-down
  detail) and the process note; then the "We're hiring." CTA. Every section
  renders only when its content exists.

### 4.9 `Roles Public.dc.html` — `/roles`, `/roles/[slug]`, `/apply` (`9a`)
Source: `RolesTable.tsx`, `applySelection.ts`, `app/roles/page.tsx`,
`app/roles/[slug]/page.tsx`, `app/apply/page.tsx`, `ApplyForm.tsx`.

**Index** — "Open roles", `128 live roles` lead paragraph, the speculative
banner when nothing is selected, the standard filter row, then the same
five-column table as the tenant board (700px scroll floor). Sticky selection
rail appears on the right once a role is picked, ending in
`CONTINUE TO APPLY →`. Pager is 25 per page. Closing line: "No fit above? Send
us your profile anyway — many of our placements come from roles that never get
posted."

**Role detail** — breadcrumb `/roles — ROLE_1042`, title 34px, description, then
two fact cards: **The role** (comp, equity, location, workplace, experience,
visa, stack, industry) and **The company** (blurb + stage, funding, team,
founded, backing, note). Then the JD block — About the role (72ch), What you'll
do, What they're looking for with Nice to have nested beneath. CTA row:
`APPLY FOR THIS ROLE →` / All open roles, plus "One application covers up to 3
roles." Keep the `JobPosting` JSON-LD and the confidential-company framing
("named during the process") — that is a commercial rule, not placeholder copy.

**Apply** — the same table with no selection UI of its own (`showSelectionUI:
false`), and `ApplyForm` in the rail as two panels:
**Your application** (cart; titles link to `/roles/[slug]` in a new tab with ↗,
hence the `slug` prop; empty and speculative variants have their own copy) and
**Your details** (the intro line changes with state; fields as
`ApplyForm.tsx`, including the multi-select locations list). Submit labels:
`SUBMIT (n ROLES) →` / `SUBMIT APPLICATION →` / `SUBMITTING…`. Six states, all
in the file: idle · sending · missing-resume error · network error · submitted
(roles named back) · `alreadyApplied`. On success the whole rail becomes the
thank-you, the form resets and `clearSelection()` runs. **No suggested-matches
list here** — that belongs to the tenant board.

`?role=1042` merges into the stored selection; `?speculative=1` hides the table
and makes the resume required.

**Selection** is `applySelection.ts`: localStorage key `tt-apply-roles`, capped
at `MAX_ROLES = 3`, broadcasting `tt-apply-roles-changed` for same-tab sync and
listening to `storage` for cross-tab. A fourth add is a silent no-op — the `n/3`
counter is what explains it, so keep the counter visible wherever APPLY +
appears.

**Search semantics are unchanged and must be preserved**: comma = OR groups,
spaces = AND, `-term` excludes, `"quoted phrase"` is literal. Sort keys stay
`id · title · location · workplace · yoe · salary`.

### 4.10 `Market Index.dc.html` — `/market-index` + `[family]` (`10a`)
Source: `app/market-index/page.tsx`, `[family]/page.tsx`, `SalaryChart.tsx`,
`lib/market.ts`, `data/market-index.json`.

Every number is the real JSON — twelve rows, four families × SF / New York /
Other-Remote, 123 searches. Both pages are static: no fetching, no loading
states.

- **Chart** stays a server-rendered inline SVG with **no chart library**: a
  horizontal range bar per family × city, x domain clamped to $100k–$320k,
  gridlines every $50k, a value label after each bar, and a `<title>` per bar
  for the native tooltip (`"family — city: median band $Xk–$Yk (from N
  searches)"`). Keeps its `compact` prop. Wrapped in a horizontal scroller with
  a 640px floor rather than squeezing.
- **Index table**: `minmax(0,2fr) 130px 80px 140px 110px; gap: 14px` → Role
  family · Market (with a legend dot) · Searches · Median band · Top of market,
  grouped in threes by family.
- Keep the "Base salary only — equity excluded… Last computed 2026-08" note, the
  two READ cards, and the guide list.
- **Family guide**: breadcrumb, title, `intro`, the bands table for that family,
  a "What the data says" panel with `read`, live roles for the family, then the
  CTA. Keep `intro` and `read` verbatim — these are SEO landing pages targeting
  specific queries.

*Additions:* four derived headline stats above the chart, the legend dot in the
table, and per-family search counts on the guide list.

### 4.11 `Agency Home.dc.html` — the homepage
Source: `app/page.tsx`, `app/layout.tsx`, `data/placements.ts`.

**This is the chosen direction** (option `11a` in `Agency Homepage.dc.html`,
which also holds two rejected alternatives — `11b` a data-led ledger, `11c` a
JD-box-as-hero — kept for reference only).

Structure: centred hero (62px display, one italic serif accent word) with the
existing claim, sub-paragraph and investor line **verbatim** → **two doors**,
one card per audience (Hiring managers / Engineers) each with its own CTA →
**Recently closed**, the five real placements as linked cards using each
record's `line` and `tag` → **How it works** (3 steps) beside a **market index
teaser** (four families, SF/NYC bars) → the dark JD CTA band → footer.

The terminal-window hero block from the current page is deliberately dropped —
it was the strongest piece of the old dark identity and has no equivalent in
this language.

⚠️ **How it works is a new section, not a restyle.** It is flagged in the file
and needs sign-off on the wording before it ships. "48 hours" appears there and
on the apply flows — confirm that is a promise you want in writing.

### 4.12 `Hirepage Landing.dc.html`
Three early marketing-landing explorations for a separate SaaS product. Not part
of this work; included only so nothing is lost.

---

## 5. Interactions

Behaviour is unchanged from the current app unless listed here. Keep all
existing fetches, optimistic updates, rollbacks, polling and URL syncing.

- Hover only, no motion, on nav rows, cards and table rows. Table row hover
  `#FBFAF8`; board card hover `border-color rgba(0,0,0,.22)`.
- Pipeline-bar tooltip: on hover, no delay, no animation; flips above for rows
  in the lower half.
- Tabs everywhere: instant swap. The job Pipeline stays mounted across tab
  switches so filters, the open drawer and counts survive; Table and Board both
  stay mounted across the view toggle.
- Drawer: slides in from the right (200ms ease-out is enough); overlay click and
  Esc close; Esc closes a nested job panel first.
- Drawer pipeline rows: click toggles the review panel, one open at a time;
  opening from a job page pre-expands that role and lands on the Pipeline tab.
- Contact icons: click copies, label swaps to "Copied ✓" for 1.4s.
- Board: HTML5 drag and drop; optimistic move with rollback; the reject strip
  exists only during a drag; rejecting confirms on the card.
- Filters menu: click to open, click the field again or outside to close.
- Sourcing run: the existing advance loop and 4s counter poll drive the progress
  card. Nothing new.
- Loading: keep the current "Loading…" / "Loading board…" text; the candidates
  table dims rather than unmounting during a refetch.
- Empty and error states: keep the current copy, restyled to `#FBFAF8` +
  hairline + `radius 14px`, 13.5px `#8A877F`.
- Responsive: the dashboard is desktop-only (≥1280px). Public pages already have
  mobile behaviour in `BoardClient` / `RolesTable` (rail stacks under the table,
  a compact bottom bar replaces it, contact actions become a pinned bar) — keep
  it.

---

## 6. State

No new state beyond what the components already hold.

- **Job workspace**: `tab` (`?tab=`), `view` (`?view=board`), `openKey`,
  `counts`, `pipelineRefresh`
- **Candidates table**: `seg`, `roleFilter`, `fit`, `q` (300ms debounce),
  `hideNotNow`, `sort`, `dir`, `page`
- **Drawer**: `tab`, `expanded` (jobId), `editingContact`, upload/stage/follow-up
  saving flags
- **Sourcing panel**: `view` (`list` | `builder` | `run`), `runs`, `credits`
- **Search builder**: `draft` (`QueryDraft`), `more`, `preview`, `starting`
- **Network**: `people`, `q`, `role`, `company`, `fit`, `newOnly`, `expanded`,
  `confirm`, `sending`
- **Board client**: `coTab`, `q`, `loc`, `office`, `type`, `visaF`, `sort`,
  `dir`, `page`, `selected`, `expanded`, `speculative`, `status`, plus the
  future-interest and booking state
- **Apply**: selection in localStorage via `applySelection`, `status`,
  `formError`

---

## 7. Assets

Nothing to import. The LinkedIn, mail and phone glyphs are the inline SVGs
already in `CandidatesTable.tsx`. Company and school logos use the existing
LinkedIn-CDN-with-letter-tile-fallback pattern (`OrgLogo`, `ChipLogo`). Avatars
are initials on a hashed colour. Fonts load from Google Fonts — Instrument Sans
plus Instrument Serif; the Archivo and IBM Plex Mono imports in
`app/layout.tsx` can go once the public pages are migrated.

---

## 8. Pitfalls — learned the hard way while building these

1. **Sibling row-grids must be content-independent.** Each row is its own grid,
   so any `max-content` or intrinsic track resolves per row and columns stop
   lining up with the header. Fixed px for label columns, `minmax(0, Nfr)` for
   elastic text. Rebuilding these as real `<table>`s also solves it — that is
   fine.
2. **A horizontal scroller needs a fixed px floor, not `max-content`.**
   `min-width: max-content` sizes the wrapper to the longest string, which
   defeats the flexible column and kills the ellipsis. Compute what the fixed
   tracks + gaps + padding actually need and set that number.
3. **If the floor is lower than the grid needs, the grid overflows its own box
   instead of stretching the scroller** — the last column gets clipped away
   rather than becoming scrollable. This bit three times: audit
   `fixed tracks + gaps + row padding` against the floor.
4. **Labels never wrap.** Fit pills, follow-up dates and stage chips need
   `white-space: nowrap`, and their track must fit the longest value
   ("Worth a message" ≈ 149px at 11.5px/600 with 10px padding).
5. **Don't add a column you can't afford.** Where the budget ran out, Company,
   Location, Office and Experience moved into the row's meta line rather than
   shrinking the identifying columns. Keep that pattern.
6. **Every row the same height.** A badge on a second line under a name breaks
   the rhythm — keep `Via TT` inline.
7. **`overflow: hidden` on a table wrapper clips the pipeline tooltip.** Leave
   it visible and round the header corners instead.
8. **An always-open dropdown in a mock hides whatever is beneath it.** Gate
   overlays behind state even in a prototype, or the reviewer never sees the two
   fields underneath.

---

## 9. Additions to decide on

Everything here is a proposal, not a restyle. Each is easy to drop.

1. **Sourcing credits moved from Settings into the sidebar.** Keep or revert?
2. **`Hide "Not now"` became a filter chip** rather than a checkbox or switch.
3. **The drawer header shows a best-fit tag** as well as the per-role tags in
   Pipeline; it can read as a verdict on the person rather than on a role.
4. **The board scrolls horizontally at nine columns.** Should interview stages
   collapse into one column beyond four?
5. **The Filters menu lists proposed filters** (location, stage, years, skills,
   visa, sourcing run, shortlisted, network match) greyed with a `soon` tag.
   Each needs a new query param on `/candidates/v2`. Keep as a roadmap in the
   UI, or hide until built?
6. **Search builder additions**: the query/credit summary rail, "balance after
   this run", and one-tap narrowing suggestions on the too-broad state.
7. **Market index additions**: four derived headline stats, the legend dot, and
   per-family search counts.
8. **Homepage "How it works"** — new copy, needs sign-off. And "48 hours" as a
   public promise.
9. **Dropped from the public site**: the terminal-window hero block, the
   invented "For companies" nav item, and the Privacy link (no such route
   exists).

---

## 10. File index

| File | Screens |
| --- | --- |
| `redesign.css` | **the stylesheet — land this first** |
| `Dashboard Shell.dc.html` | shell + Jobs list (`2a`), Foundations token reference (`2b`) |
| `Candidates.dc.html` | unified candidate pool (`3a`) |
| `Candidate Drawer.dc.html` | candidate profile drawer (`4a`) |
| `Job Detail.dc.html` | job workspace — Overview / Pipeline / Sourcing / Past (`5a`) |
| `Job Form.dc.html` | new + edit job |
| `Settings.dc.html` | org settings + StageEditor modal |
| `Team.dc.html` | seats, invites, roles, member stats |
| `My Page Editor.dc.html` | recruiter page settings + preview |
| `Search Builder.dc.html` | guided sourcing search, all preview states (`7a`) |
| `Network.dc.html` | network matches (`8a`), auth + access states (`8b`) |
| `Public Board.dc.html` | tenant board and recruiter page (`6a`) |
| `Roles Public.dc.html` | `/roles`, `/roles/[slug]`, `/apply` (`9a`) |
| `Market Index.dc.html` | market index + family guide (`10a`) |
| `Agency Home.dc.html` | **the homepage — chosen direction** |
| `Agency Homepage.dc.html` | the three homepage options (`11a` chosen, `11b`/`11c` reference) |
| `Hirepage Landing.dc.html` | unrelated SaaS landing explorations |
| `support.js` | prototype runtime — **do not port** |
| `github.md` | repo, branch and screen → source map |

---

## 11. Suggested order of work

1. **Shell + Jobs list** — establishes every token, the nav and the table
   pattern. Everything else inherits from it.
2. **Candidates + drawer** — the densest surfaces and the filter pattern.
3. **Job workspace** — reuses the table, the drawer and the board.
4. **Search builder** — completes the sourcing loop.
5. **Settings / Team / My page / Job form** — mechanical once the shell is done.
6. **Network + auth states** — small, and the auth states gate everything.
7. **Public board + recruiter page** — the candidate-facing surface, and the
   commercially important one.
8. **Roles / apply / market index** — the public site's data pages.
9. **Homepage** — last, once the public chrome is settled by step 8.

Do one screen per branch, stop for review on a preview deploy before starting
the next.
