// Synthetic fixture setup only. Establish a real legacy save, stored integrity
// check, historical record/checkpoint and production anchor RPC. Never imported
// by application code and never accepts a production connection URL.
import pg from "pg";
import * as lib from "../dist/worker-lib.mjs";
import { pgSite, readNew, checkStored, Tally } from "../person-trial.mjs";
import { anchorDatabaseConfig } from "./database.mjs";
export async function prepareAuditFixture(
  candidateId,
  { directory = null } = {},
) {
  const url = process.env.LOCAL_DATABASE_URL;
  if (!url) throw Error("local_database_required");
  const client = new pg.Client(
    anchorDatabaseConfig({ LOCAL_DATABASE_URL: url }),
  );
  await client.connect();
  let site;
  try {
    if (
      (
        await client.query(
          "select 1 from person_audit_anchors where candidate_id=$1",
          [candidateId],
        )
      ).rowCount
    )
      return;
    const rows = async (table, columns = "*", extra = "") =>
      (
        await client.query(
          `select to_jsonb(x) r from (select ${columns} from ${table} where candidate_id=$1 ${extra})x order by x.id`,
          [candidateId],
        )
      ).rows.map((x) => x.r);
    const row = (
      await client.query("select to_jsonb(c) r from candidates c where id=$1", [
        candidateId,
      ])
    ).rows[0]?.r;
    if (!row) throw Error("fixture_candidate_missing");
    const input = {
      row,
      legacy: await rows("candidate_emails"),
      v2: await rows("candidate_emails_v2"),
      comms: await rows(
        "candidate_communications",
        "id,candidate_id,communication_type,status,email_used,communication_date,response_date",
        "and communication_type='email' and status in ('bounced','replied')",
      ),
      ledger: [],
      apps: [],
      dir: directory,
    };
    const doc = lib.fromLegacyImport(row, input.legacy, input.v2, input.comms);
    const docs = [
      doc,
      ...(directory
        ? [
            lib.fromDirectory(
              directory.board,
              directory.harvest,
              directory.exps,
              directory.edus,
              directory.emails,
              directory.phones,
              candidateId,
            ),
          ]
        : []),
    ];
    for (const inputDoc of docs)
      await client.query("select save_person($1::jsonb)", [inputDoc]);
    site = await pgSite(url);
    const stored = await readNew(site, [candidateId], { globalCounts: false });
    const tally = new Tally();
    const { _projection, ...checks } = checkStored(
      tally,
      candidateId,
      input,
      docs,
      stored,
      lib,
    );
    if (tally.fail.size) throw Error("fixture_historical_integrity");
    const run = `audit-fixture-${candidateId}`;
    const exists =
      (await client.query("select 1 from backfill_runs where run_id=$1", [run]))
        .rowCount > 0;
    await client.query(
      "select person_reconcile_start($1,'c4d0e4e9b11e2fd88d4b087967bf3ae490a5f0bc',100,1,$2,'all',repeat('0',32))",
      [run, exists],
    );
    const version = (
      await client.query(
        "select coalesce(max(id),0)::text n from person_change_events where candidate_id=$1",
        [candidateId],
      )
    ).rows[0].n;
    await client.query("begin");
    await client.query("select person_reconcile_record_many($1,$2::jsonb)", [
      run,
      JSON.stringify([
        {
          candidate_id: candidateId,
          version,
          status: "verified",
          revision: stored.state.get(candidateId).rev,
          source_hash: doc.source.payload_hash,
          checks: { ...checks, integrity_ok: true, external_stable: true },
        },
      ]),
    ]);
    await client.query("select person_reconcile_checkpoint($1,$2::jsonb)", [
      run,
      JSON.stringify([candidateId]),
    ]);
    const snapshot = (
      await client.query("select person_audit_anchor_inputs($1::jsonb) r", [
        JSON.stringify([candidateId]),
      ])
    ).rows[0].r[0];
    const item = lib.prepareLegacyAuditAnchor(snapshot);
    if (item.status !== "ready") throw Error(`fixture_anchor_${item.reason}`);
    const result = (
      await client.query("select person_audit_anchor_commit($1::jsonb) r", [
        JSON.stringify([item]),
      ])
    ).rows[0].r[0];
    if (result.status !== "created") throw Error("fixture_anchor_not_created");
    await client.query("commit");
    return doc;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await site?.end();
    await client.end();
  }
}
