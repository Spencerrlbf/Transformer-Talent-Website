import assert from "node:assert/strict";
import { test, after } from "node:test";
import pg from "pg";
const url = process.env.LOCAL_DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("local database required");
const db = new pg.Pool({ connectionString: url, max: 5 });
after(() => db.end());
const id = (n) => `d5000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TT = "801865a7-6533-41d2-9c45-e4a90e6ad51a";
const use = async (fn) => {
  const c = await db.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
};
const candidate = async (n) => {
  await db.query(
    "insert into candidates(id,full_name,linkedin_username) values($1,'Synthetic Audit',$2)",
    [id(n), `audit-${n}`],
  );
};
const epoch = async (kind, key) =>
  Number(
    (
      await db.query(
        "select count(*) n from person_audit_epochs where scope_kind=$1 and scope_key=$2",
        [kind, key],
      )
    ).rows[0].n,
  );
const app = async (n) => {
  await candidate(n);
  await db.query(
    "insert into website_applications(id,organization_id,name,email,candidate_id) values($1,$2,'Synthetic','synthetic@example.test',$3)",
    [id(n + 100), TT, id(n)],
  );
};
const receipt = (c, n) =>
  c.query(
    "insert into person_application_receipts(application_id,candidate_id,created_person,documents,application_snapshot) values($1,$2,false,'[]','{}')",
    [id(n + 100), id(n)],
  );
const operation = (c, n, kind = "application") =>
  c.query(
    "insert into person_audit_operations(id,candidate_id,writer,receipt_ref) values($1,$2,$3,$4)",
    [id(n + 1000), id(n), kind, `${kind}:${id(n + 100)}`],
  );
const capture = (c, n) =>
  c
    .query(
      "select id from person_change_events where candidate_id=$1 and source_table='candidates' and transaction_id=pg_current_xact_id() order by id desc limit 1",
      [id(n)],
    )
    .then((r) => r.rows[0].id);
const attribute = (c, event, op, kind) =>
  c.query("select person_private.attribute_change($1,$2,$3)", [
    event,
    op,
    kind,
  ]);
test("audit infrastructure exists without activating any writer", async () => {
  assert.equal(
    (await db.query("select to_regclass('person_audit_epochs')::text name"))
      .rows[0].name,
    "person_audit_epochs",
  );
});
test("semantic receipt changes advance epoch, duplicate writes in one transaction coalesce", async () => {
  await app(1);
  assert.equal(await epoch("candidate", id(1)), 0);
  await use(async (c) => {
    await c.query("begin");
    await receipt(c, 1);
    await c.query(
      "update person_application_receipts set application_snapshot='{\"test\":1}' where candidate_id=$1",
      [id(1)],
    );
    await c.query("commit");
  });
  assert.equal(await epoch("candidate", id(1)), 1);
  await db.query(
    "update person_application_receipts set created_at=created_at where candidate_id=$1",
    [id(1)],
  );
  assert.equal(await epoch("candidate", id(1)), 1);
  await db.query(
    "update person_application_receipts set documents='[{}]' where candidate_id=$1",
    [id(1)],
  );
  assert.equal(await epoch("candidate", id(1)), 2);
});
test("reverse commit order cannot hide a late receipt transaction", async () => {
  await app(2);
  await app(3);
  // Different receipts associated with one person avoid taking a counter row or
  // conflicting receipt row. The later allocated transaction commits first.
  await use(async (a) =>
    use(async (b) => {
      await a.query("begin");
      await receipt(a, 2);
      await b.query("begin");
      await b.query(
        "insert into person_application_receipts(application_id,candidate_id,created_person,documents,application_snapshot) values($1,$2,false,'[]','{}')",
        [id(103), id(2)],
      );
      await b.query("commit");
      assert.equal(await epoch("candidate", id(2)), 1);
      await a.query("commit");
      assert.equal(await epoch("candidate", id(2)), 2);
    }),
  );
});
test("rollback leaves no committed epoch; reassignment marks both candidates", async () => {
  await app(4);
  await candidate(5);
  await use(async (c) => {
    await c.query("begin");
    await receipt(c, 4);
    await c.query("rollback");
  });
  assert.equal(await epoch("candidate", id(4)), 0);
  await receipt(db, 4);
  await db.query(
    "update person_application_receipts set candidate_id=$2 where candidate_id=$1",
    [id(4), id(5)],
  );
  assert.equal(await epoch("candidate", id(4)), 2);
  assert.equal(await epoch("candidate", id(5)), 1);
});
test("unassigned directory staging is visible and lease/derivative noise does not advance epochs", async () => {
  await db.query(
    "insert into person_directory_scans(workspace_id) values($1)",
    [id(50)],
  );
  const r = (
    await db.query(
      "insert into person_directory_receipts(workspace_id,contact_id,snapshot_hash,snapshot) values($1,$2,'synthetic','{}') returning id",
      [id(50), id(51)],
    )
  ).rows[0];
  assert.equal(await epoch("directory", id(51)), 1);
  await db.query(
    "update person_directory_receipts set derivative_token=gen_random_uuid(),derivative_attempts=1,derivative_done=true,attempts=1,updated_at=clock_timestamp() where id=$1",
    [r.id],
  );
  assert.equal(await epoch("directory", id(51)), 1);
  await db.query(
    "update person_directory_receipts set phase='done',source_reviews='[{\"reason\":\"unknown_date\"}]' where id=$1",
    [r.id],
  );
  assert.equal(await epoch("directory", id(51)), 2);
  await db.query(
    "insert into person_directory_state(contact_id,workspace_id,latest_receipt_id,seen_cycle) values($1,$2,$3,1)",
    [id(51), id(50), r.id],
  );
  assert.equal(await epoch("directory", id(51)), 3);
  await db.query(
    "update person_directory_state set seen_cycle=2 where contact_id=$1",
    [id(51)],
  );
  assert.equal(await epoch("directory", id(51)), 3);
});
test("refresh lease noise is excluded; source evidence and admission state are included", async () => {
  await candidate(6);
  await db.query(
    "insert into person_refresh_attempts(queue_id,candidate_id,organization_id,phase,linkedin_username,linkedin_url) values($1,$2,$3,'ready','audit-6','https://linkedin.com/in/audit-6')",
    [id(106), id(6), TT],
  );
  const before = await epoch("candidate", id(6));
  await db.query(
    "update person_refresh_attempts set lease_until=clock_timestamp(),claim_token=gen_random_uuid(),attempts=1,phase='claimed',derivatives_claimed_at=clock_timestamp() where candidate_id=$1",
    [id(6)],
  );
  assert.equal(await epoch("candidate", id(6)), before);
  await db.query(
    "update person_refresh_attempts set phase='done',documents='[]',result='{\"revision\":1}' where candidate_id=$1",
    [id(6)],
  );
  assert.equal(await epoch("candidate", id(6)), before + 1);
});
test("exact event attribution is bound to operation, candidate, table and transaction", async () => {
  await candidate(7);
  let event;
  await use(async (c) => {
    await c.query("begin");
    await operation(c, 7);
    await c.query(
      "update candidates set current_title='Canonical title' where id=$1",
      [id(7)],
    );
    event = await capture(c, 7);
    await attribute(c, event, id(1007), "profile");
    await c.query("commit");
  });
  const link = (
    await db.query(
      "select candidate_id,operation_id,scope,changed_fields from person_change_attributions where event_id=$1",
      [event],
    )
  ).rows[0];
  assert.equal(link.candidate_id, id(7));
  assert.equal(link.operation_id, id(1007));
  assert.equal(link.scope, "profile");
  assert.deepEqual(link.changed_fields, ["current_title"]);
  await assert.rejects(
    attribute(db, event, id(1007), "profile"),
    /audit_event_transaction/,
  );
  await assert.rejects(
    db.query(
      "update person_change_attributions set scope=scope where event_id=$1",
      [event],
    ),
    /audit_evidence_immutable/,
  );
});
test("mixed unrelated candidate fields cannot be attributed as a projection", async () => {
  await candidate(8);
  await use(async (c) => {
    await c.query("begin");
    try {
      await operation(c, 8);
      await c.query(
        "update candidates set current_title='Canonical',contact='{\"email\":\"unexpected@example.test\"}' where id=$1",
        [id(8)],
      );
      const event = await capture(c, 8);
      await assert.rejects(
        attribute(c, event, id(1008), "profile"),
        /audit_event_fields/,
      );
    } finally {
      await c.query("rollback");
    }
  });
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_audit_operations where candidate_id=$1",
        [id(8)],
      )
    ).rows[0].n,
    0,
  );
});
test("old or different-person events are never rescued by a new matching operation", async () => {
  await candidate(9);
  await candidate(10);
  await use(async (c) => {
    await c.query("begin");
    try {
      await operation(c, 9);
      await c.query(
        "update candidates set current_title='Other person' where id=$1",
        [id(10)],
      );
      await assert.rejects(
        attribute(c, await capture(c, 10), id(1009), "profile"),
        /audit_event_identity/,
      );
    } finally {
      await c.query("rollback");
    }
  });
});
test("receipt creation and application finalization have separate exact scopes", async () => {
  await use(async (c) => {
    await c.query("begin");
    await c.query(
      "insert into candidates(id,full_name,linkedin_username,source) values($1,'Synthetic New','audit-new','website_applicant')",
      [id(12)],
    );
    await operation(c, 12);
    await attribute(c, await capture(c, 12), id(1012), "creation");
    await c.query(
      "insert into website_applications(id,organization_id,name,email) values($1,$2,'Synthetic','synthetic@example.test')",
      [id(112), TT],
    );
    await c.query(
      "update website_applications set candidate_id=$2,pool_created_person=true,parsed_profile=$3 where id=$1",
      [id(112), id(12), { profile_summary: "Synthetic summary" }],
    );
    const event = (
      await c.query(
        "select id from person_change_events where source_table='website_applications' and candidate_id=$1 and transaction_id=pg_current_xact_id() order by id desc limit 1",
        [id(12)],
      )
    ).rows[0].id;
    await attribute(c, event, id(1012), "application_finalize");
    await c.query("commit");
  });
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from person_change_attributions where candidate_id=$1",
        [id(12)],
      )
    ).rows[0].n,
    2,
  );
});
test("writer-specific metadata and contact scopes cannot be used by another writer", async () => {
  for (const [n, writer, scope, sql] of [
    [
      13,
      "refresh",
      "refresh_metadata",
      "linkedin_enrichment_date=clock_timestamp(),calculated_experience_years=4",
    ],
    [
      14,
      "directory",
      "directory_metadata",
      "source='directory',directory_contact_id='d5000000-0000-4000-8000-000000000014'",
    ],
    [
      15,
      "recruiter",
      "recruiter_contact",
      'contact=\'{"email":"manual@example.test"}\'',
    ],
  ]) {
    await candidate(n);
    await use(async (c) => {
      await c.query("begin");
      await operation(c, n, writer);
      await c.query(`update candidates set ${sql} where id=$1`, [id(n)]);
      await attribute(c, await capture(c, n), id(n + 1000), scope);
      await c.query("commit");
    });
  }
  await candidate(16);
  await use(async (c) => {
    await c.query("begin");
    try {
      await operation(c, 16, "application");
      await c.query("update candidates set contact='{}' where id=$1", [id(16)]);
      await assert.rejects(
        attribute(c, await capture(c, 16), id(1016), "recruiter_contact"),
        /audit_event_writer/,
      );
    } finally {
      await c.query("rollback");
    }
  });
});
test("anchors, operations, event links and epoch markers are private and immutable", async () => {
  await candidate(11);
  await operation(db, 11);
  await db.query(
    "insert into person_audit_anchors(candidate_id,kind,creator_ref,before_image,revision,captured_version,anchor_hash) values($1,'receipt_created',$2,'{}',0,0,'synthetic')",
    [id(11), `application:${id(111)}`],
  );
  await assert.rejects(
    db.query(
      "update person_audit_anchors set anchor_hash='replacement' where candidate_id=$1",
      [id(11)],
    ),
    /audit_evidence_immutable/,
  );
  await assert.rejects(
    db.query("delete from person_audit_epochs where scope_key=$1", [id(11)]),
    /audit_evidence_immutable/,
  );
  const rows = (
    await db.query(
      "select relname,relrowsecurity rls,has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') anon,has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') authenticated from pg_class where relname=any($1::text[])",
      [
        [
          "person_audit_anchors",
          "person_audit_operations",
          "person_change_attributions",
          "person_audit_epochs",
        ],
      ],
    )
  ).rows;
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.rls && !r.anon && !r.authenticated));
  assert.equal(
    (
      await db.query(
        "select has_function_privilege('authenticated','person_private.attribute_change(bigint,uuid,text)','execute') allowed",
      )
    ).rows[0].allowed,
    false,
  );
});
test("a legacy anchor cannot be accepted without its frozen legacy document", async () => {
  await candidate(17);
  await db.query(
    "insert into backfill_runs(run_id,pass,status,processed,conflicts) values('audit-synthetic-baseline','shadow','paused',0,0)",
  );
  await assert.rejects(
    db.query(
      "insert into person_audit_anchors(candidate_id,kind,baseline_run,before_image,revision,captured_version,anchor_hash) values($1,'legacy','audit-synthetic-baseline','{}',1,0,'synthetic')",
      [id(17)],
    ),
    (e) => e.code === "23514",
  );
});
test("missing captured identity fails closed instead of passing a SQL NULL comparison", async () => {
  await candidate(18);
  await use(async (c) => {
    await c.query("begin");
    try {
      await operation(c, 18);
      await c.query(
        "update candidates set current_title='Synthetic' where id=$1",
        [id(18)],
      );
      const event = await capture(c, 18);
      await c.query(
        "update person_change_events set payload=payload-'id',previous_payload=previous_payload-'id' where id=$1",
        [event],
      );
      await assert.rejects(
        attribute(c, event, id(1018), "profile"),
        /audit_event_identity/,
      );
    } finally {
      await c.query("rollback");
    }
  });
});
test("refresh identity metadata changes invalidate a previous audit", async () => {
  const before = await epoch("candidate", id(6));
  await db.query(
    "update person_refresh_attempts set linkedin_username='changed-synthetic' where candidate_id=$1",
    [id(6)],
  );
  assert.equal(await epoch("candidate", id(6)), before + 1);
});
test("an application deletion cannot masquerade as parse finalization", async () => {
  await app(19);
  await use(async (c) => {
    await c.query("begin");
    try {
      await operation(c, 19);
      await c.query("delete from website_applications where id=$1", [id(119)]);
      const event = (
        await c.query(
          "select id from person_change_events where candidate_id=$1 and source_table='website_applications' and operation='DELETE' and transaction_id=pg_current_xact_id()",
          [id(19)],
        )
      ).rows[0].id;
      await assert.rejects(
        attribute(c, event, id(1019), "application_finalize"),
        /audit_event_scope/,
      );
    } finally {
      await c.query("rollback");
    }
  });
});
test("creation rejects facts outside the minimal identity seed, including location", async () => {
  await use(async (c) => {
    await c.query("begin");
    try {
      await c.query(
        "insert into candidates(id,full_name,linkedin_username,location) values($1,'Synthetic','audit-fact-seed','Unproven location')",
        [id(20)],
      );
      await operation(c, 20);
      await assert.rejects(
        attribute(c, await capture(c, 20), id(1020), "creation"),
        /audit_event_fields/,
      );
    } finally {
      await c.query("rollback");
    }
  });
});
test("application finalization cannot borrow another receipt for the same candidate", async () => {
  await app(21);
  await use(async (c) => {
    await c.query("begin");
    try {
      await c.query(
        "insert into person_audit_operations(id,candidate_id,writer,receipt_ref) values($1,$2,'application',$3)",
        [id(1021), id(21), `application:${id(999)}`],
      );
      await c.query(
        'update website_applications set parsed_profile=\'{"current_title":"Synthetic"}\' where id=$1',
        [id(121)],
      );
      const event = (
        await c.query(
          "select id from person_change_events where candidate_id=$1 and source_table='website_applications' and transaction_id=pg_current_xact_id() order by id desc limit 1",
          [id(21)],
        )
      ).rows[0].id;
      await assert.rejects(
        attribute(c, event, id(1021), "application_finalize"),
        /audit_event_receipt/,
      );
    } finally {
      await c.query("rollback");
    }
  });
});
test("migration leaves preexisting events unattributed and only stamps future captures", async () => {
  const old = (
    await db.query(
      "select transaction_id from person_change_events where candidate_id=$1",
      [id(900)],
    )
  ).rows;
  assert.ok(old.length > 0);
  assert.ok(old.every((x) => x.transaction_id === null));
  await db.query(
    "update candidates set status='Synthetic status' where id=$1",
    [id(900)],
  );
  assert.equal(
    (
      await db.query(
        "select transaction_id is not null as stamped from person_change_events where candidate_id=$1 order by id desc limit 1",
        [id(900)],
      )
    ).rows[0].stamped,
    true,
  );
});
test("receipt-only writes participate in the existing finalization capture gate", async () => {
  await app(22);
  await use(async (c) => {
    await c.query("begin");
    try {
      await receipt(c, 22);
      await use(async (gate) => {
        await gate.query("begin");
        try {
          assert.equal(
            (await gate.query("select pg_try_advisory_xact_lock(72006,0) ok"))
              .rows[0].ok,
            false,
          );
        } finally {
          await gate.query("rollback");
        }
      });
    } finally {
      await c.query("rollback");
    }
  });
});
test("service role cannot truncate or rewrite append-only audit evidence", async () => {
  const rows = (
    await db.query(
      "select relname,has_table_privilege('service_role',oid,'SELECT') readable,has_table_privilege('service_role',oid,'INSERT') appendable,has_table_privilege('service_role',oid,'UPDATE,DELETE,TRUNCATE') mutable from pg_class where relname=any($1::text[])",
      [
        [
          "person_audit_anchors",
          "person_audit_operations",
          "person_change_attributions",
          "person_audit_epochs",
        ],
      ],
    )
  ).rows;
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.readable && r.appendable && !r.mutable));
});
