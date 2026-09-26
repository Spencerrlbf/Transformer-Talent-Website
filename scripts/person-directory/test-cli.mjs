import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { openComms, commsColumns, readDirectory } from "../person-trial.mjs";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
const db = new pg.Client({ connectionString: url });
await db.connect();
const ws = "d3000000-0000-4000-8000-000000000001",
  contact = "d3000000-0000-4000-8000-000000000002";
const run = (dry) =>
  spawnSync(process.execPath, ["scripts/sync-directory.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PERSON_WRITE_MODE: "live",
      PERSON_DATABASE_URL: url,
      COMMS_DATABASE_URL: url,
      COMMS_WORKSPACE: "Synthetic directory",
      OPENAI_API_KEY: "",
      PERSON_DIRECTORY_EMBED_LIMIT: "0",
      DRY_RUN: dry ? "1" : "",
      LIMIT: "1",
    },
    timeout: 30000,
  });
after(() => db.end());
await test("actual directory reader uses one read-only repeatable snapshot including provenance", async () => {
  await db.query(`create schema comms;create schema board;
 create table comms.workspaces(id uuid primary key,name text);
 create table comms.contacts(id uuid primary key,workspace_id uuid);
 create table board.candidates(contact_id uuid primary key,name text,linkedin_url text,primary_email text,email_status text,status text,do_not_contact bool,updated_at timestamptz);
 create table comms.harvest_profiles(contact_id uuid primary key,fetched_at timestamptz,public_identifier text,headline text,source_version_id uuid);
 create table comms.contact_experiences(contact_id uuid,title text,company_name text,start_year int,is_current bool,superseded_at timestamptz,sort_order int);
 create table comms.contact_educations(contact_id uuid,school_name text,superseded_at timestamptz,sort_order int);
 create table comms.emails(contact_id uuid,normalized text,original_value text,classification text,verification jsonb);
 create table comms.profile_facts(id uuid primary key,contact_id uuid,field text,value jsonb,provenance text,recorded_at timestamptz);
 create table comms.identifiers(contact_id uuid,kind text,value text,original_value text);
 create table comms.source_versions(id uuid primary key,payload jsonb,captured_at timestamptz)`);
  await db.query("insert into comms.workspaces values($1,$2)", [
    ws,
    "Synthetic directory",
  ]);
  await db.query("insert into comms.contacts values($1,$2)", [contact, ws]);
  await db.query(
    "insert into board.candidates values($1,'Synthetic CLI','https://www.linkedin.com/in/directory-cli','cli@example.test','Verified','Replied',false,'2026-09-01')",
    [contact],
  );
  await db.query(
    "insert into comms.harvest_profiles values($1,'2026-08-01','directory-cli','Synthetic headline',null)",
    [contact],
  );
  await db.query(
    "insert into comms.contact_experiences values($1,'Senior Engineer','Synthetic CLI Co',2020,true,null,0)",
    [contact],
  );
  await db.query(
    `insert into comms.emails values($1,'cli@example.test','cli@example.test','personal','{"status":"Verified","primary":true,"checked_at":"2026-08-01"}')`,
    [contact],
  );
  await db.query(
    "insert into comms.profile_facts values('d3000000-0000-4000-8000-000000000003',$1,'phone','\"2025550123\"','manual','2026-07-01')",
    [contact],
  );
  await db.query(
    "insert into comms.identifiers values($1,'linkedin','https://www.linkedin.com/in/cli-alias',null)",
    [contact],
  );
  const reader = await openComms(url);
  try {
    const cols = await commsColumns(reader);
    let updated = false;
    const proxy = {
      query: async (sql, params) => {
        const result = await reader.query(sql, params);
        if (sql.startsWith("select * from board.candidates") && !updated) {
          updated = true;
          await db.query(
            "update comms.profile_facts set value='\"2025550199\"' where contact_id=$1",
            [contact],
          );
        }
        return result;
      },
    };
    const a = (
      await readDirectory(proxy, [contact], cols, { provenance: true })
    ).get(contact);
    assert.equal(a.facts[0].value, "2025550123");
    assert.equal(
      a.identifiers[0].value,
      "https://www.linkedin.com/in/cli-alias",
    );
    const b = (
      await readDirectory(reader, [contact], cols, { provenance: true })
    ).get(contact);
    assert.equal(b.facts[0].value, "2025550199");
    await reader.query("set default_transaction_read_only=off");
    const attempted = {
      query: async (sql, params) => {
        if (sql.startsWith("select * from board.candidates"))
          await reader.query(
            "update comms.emails set classification='business'",
          );
        return reader.query(sql, params);
      },
    };
    await assert.rejects(
      readDirectory(attempted, [contact], cols, { provenance: true }),
      (e) => e.code === "25006",
    );
  } finally {
    await reader.end();
  }
});
await test("actual normalized CLI dry run writes nothing", async () => {
  const before = (
    await db.query("select count(*)::int n from person_directory_receipts")
  ).rows[0].n;
  const r = run(true);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /normalized_directory_complete/);
  assert.equal(
    (await db.query("select count(*)::int n from person_directory_receipts"))
      .rows[0].n,
    before,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from candidates where linkedin_username='directory-cli'",
      )
    ).rows[0].n,
    0,
  );
});
await test("actual normalized CLI admits and projects using only website transactions", async () => {
  const before = (
    await db.query(
      "select md5(jsonb_agg(t)::text) hash from (select * from comms.emails order by contact_id) t",
    )
  ).rows[0].hash;
  const r = run(false);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"saved":1/);
  const person = (
    await db.query(
      "select current_title,email,directory_contact_id from candidates where linkedin_username in ('directory-cli','cli-alias')",
    )
  ).rows;
  assert.equal(person.length, 1);
  assert.equal(person[0].current_title, "Senior Engineer");
  assert.equal(person[0].email, "cli@example.test");
  assert.equal(person[0].directory_contact_id, contact);
  assert.equal(
    (
      await db.query(
        "select md5(jsonb_agg(t)::text) hash from (select * from comms.emails order by contact_id) t",
      )
    ).rows[0].hash,
    before,
  );
});
