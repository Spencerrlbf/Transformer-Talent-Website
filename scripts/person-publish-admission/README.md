# Publication while armed and open

Prepared only. `20260928050000_person_publish_admission.sql` implements Spencer's
2026-09-28 decision. Profile publication runs while the controller is armed and
**open**, so admitted writers keep working, and it is bound to one named publish run.

## Operator steps

1. With the controller open, open a `publish` maintenance window for the run ID the
   CLI will use. It lasts 1 to 720 minutes, and only one maintenance window exists
   at a time.
2. Run `scripts/person-publish.mjs --mode=publish --run-id=RUN ...` from a direct
   session (`PERSON_PUBLISH_DATABASE_URL`).
3. Close the window. If a window expires, the run stops and records `failed`. Open a
   new window for the same run, then resume with `--resume`.

## How it works

- While the controller is on, `publishPersonProjectionOnConnection` calls
  `person_publish_project(run, candidate, revision, envelope)`, which:
  - opens the window's frame;
  - creates the guarded audit operation in SQL, in the same way as the other
    families. Its evidence matches today's publish operation: writer `projection`,
    receipt `projection:publish:RUN:<id>`, evidence mode, run and guard;
  - registers the operation as certified;
  - applies the projection through the shared `projection_apply`. History rows
    carry the run ID, so undo-by-run still selects them;
  - adds profile attribution through `attribute_change`, which now has a publish
    branch.
- With the controller disabled, or the transition schema absent, the existing
  publish path is used unchanged.
- Draining refuses publication (`maintenance_requires_open`). Seal waits until the
  window is closed.
- `person_publish_project`, `maintenance_open` and every helper are not executable
  by any API role.

**Not included:** undo while armed. `person-publish-undo.mjs` still uses its direct
path, which the fences refuse while armed. That needs its own admitted path before
any post-cutover undo.

## Verification

```sh
node scripts/build-worker-lib.mjs
PSQL=/path/to/psql bash scripts/person-publish-admission/run-local-tests.sh PORT
```

On 2026-09-28, publication with the controller open passed 9/9 through the real
publish runner, covering:

- no window, and a window for another run;
- a projected person and an audit-blocked person;
- history, operation and certified-registry evidence;
- the person verifying in the post-cutover audit after publication, and again after a
  second, unchanged publication;
- draining, operator-only access, and the disabled path.

Other suites on the same change:

| Suite | Result |
|---|---|
| Existing publish suite (`scripts/person-publish/run-local-tests.sh`) | 39/39 |
| Maintenance, current and pinned `c4d0e4e` runner | 10/10 each |
| Application edits | 34/34 |
| Cross-family suite | 504/504 |
| `tsc` | passes |

The publish harness uses whatever worker lib is already built, so run
`node scripts/build-worker-lib.mjs` first. No production database or hosted preview
was used.
