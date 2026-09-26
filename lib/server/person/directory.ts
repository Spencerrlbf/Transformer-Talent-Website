// Website-only intake. External reads and paid work are outside transactions.
import { randomUUID } from "node:crypto";
import { TT_ORG_ID, isoOf } from "./normalize";
import { fromDirectory } from "./fromDirectory";
import {
  directoryDocuments,
  directoryIdentities,
  directorySnapshotHash,
  directoryPrimary,
  directoryCanonicalUsername,
  type DirectorySnapshot,
} from "./directory-sources";
import {
  beginPersonTransaction,
  lockPerson,
  savePersonLocked,
  withPersonConnection,
  type PersonConnection,
} from "./save";
import type { PersonDoc } from "./types";
import { poolProfileText, poolSignals } from "../pool/profile";
import { enqueuePersonDerivativesLocked } from './derivatives';
const matchingText = (row: any) =>
  (poolProfileText(row) + ". actively engaged software candidate").slice(
    0,
    8000,
  );
type Scope = { organizationId: string };
type Scan = Scope & { workspaceId: string };
type Lease = Scan & { token: string };
function scope(a: Scope) {
  if (a.organizationId !== TT_ORG_ID) throw Error("person_directory_tenant");
}
async function tx<T>(
  c: PersonConnection,
  a: Scope,
  fn: () => Promise<T>,
): Promise<T> {
  scope(a);
  try {
    await beginPersonTransaction(c);
    const out = await fn();
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}
async function scanRow(c: PersonConnection, a: Lease) {
  const r = (
    await c.query(
      "select *,lease_until>clock_timestamp() active from public.person_directory_scans where workspace_id=$1 for update",
      [a.workspaceId],
    )
  ).rows[0];
  if (!r || r.token !== a.token || !r.active)
    throw Error("person_directory_lease");
  return r;
}
export async function claimDirectoryScanOnConnection(
  c: PersonConnection,
  a: Scan,
) {
  return tx(c, a, async () => {
    await c.query(
      "insert into public.person_directory_scans(workspace_id) values($1) on conflict do nothing",
      [a.workspaceId],
    );
    const r = (
      await c.query(
        "select *,lease_until>clock_timestamp() active from public.person_directory_scans where workspace_id=$1 for update",
        [a.workspaceId],
      )
    ).rows[0];
    if (r.active) return { status: "busy" as const };
    const token = randomUUID();
    await c.query(
      "update public.person_directory_scans set token=$2,lease_until=clock_timestamp()+interval '10 minutes',updated_at=clock_timestamp() where workspace_id=$1",
      [a.workspaceId, token],
    );
    return {
      status: "claimed" as const,
      token,
      cursor: r.cursor,
      cycle: r.cycle,
    };
  });
}
export async function checkpointDirectoryScanOnConnection(
  c: PersonConnection,
  a: Lease & { cursor: string; release?: boolean; complete?: boolean },
) {
  return tx(c, a, async () => {
    const r = await scanRow(c, a);
    if (!a.complete && a.cursor < r.cursor)
      throw Error("person_directory_cursor");
    await c.query(
      `update public.person_directory_scans set cursor=$2,cycle=cycle+$3,token=case when $4 then null else token end,lease_until=case when $4 then null else clock_timestamp()+interval '10 minutes' end,updated_at=clock_timestamp() where workspace_id=$1`,
      [
        a.workspaceId,
        a.complete ? "00000000-0000-0000-0000-000000000000" : a.cursor,
        a.complete ? 1 : 0,
        !!a.release,
      ],
    );
    return { status: "checkpointed" as const };
  });
}
export async function stageDirectoryOnConnection(
  c: PersonConnection,
  a: Lease & { snapshot: DirectorySnapshot },
) {
  const hash = directorySnapshotHash(a.snapshot),
    contactId = a.snapshot.board.contact_id;
  return tx(c, a, async () => {
    const scan = await scanRow(c, a);
    await c.query("select pg_advisory_xact_lock(72011,hashtext($1))", [
      contactId,
    ]);
    const state = (
      await c.query(
        "select s.*,r.snapshot_hash,r.phase,r.projected,jsonb_array_length(r.source_reviews) review_count from public.person_directory_state s join public.person_directory_receipts r on r.id=s.latest_receipt_id where s.contact_id=$1 for update of s",
        [contactId],
      )
    ).rows[0];
    if (state && state.workspace_id !== a.workspaceId)
      throw Error("person_directory_workspace");
    // A retry must consume the previously accepted immutable input before
    // accepting a different observation. The caller then stages its new input.
    if (state?.phase === "ready" && state.snapshot_hash !== hash)
      return {
        receiptId: String(state.latest_receipt_id),
        phase: "ready",
        projected: state.projected,
        pendingPrevious: true,
      };
    let receiptId =
      state?.snapshot_hash === hash ? state.latest_receipt_id : null;
    if (!receiptId)
      receiptId = (
        await c.query(
          "insert into public.person_directory_receipts(workspace_id,contact_id,snapshot_hash,snapshot) values($1,$2,$3,$4) returning id",
          [a.workspaceId, contactId, hash, a.snapshot],
        )
      ).rows[0].id;
    await c.query(
      "insert into public.person_directory_state(contact_id,workspace_id,latest_receipt_id,seen_cycle) values($1,$2,$3,$4) on conflict(contact_id) do update set latest_receipt_id=excluded.latest_receipt_id,seen_cycle=excluded.seen_cycle",
      [contactId, a.workspaceId, receiptId, scan.cycle],
    );
    return {
      receiptId: String(receiptId),
      phase: state?.snapshot_hash === hash ? state.phase : "ready",
      projected: state?.snapshot_hash === hash ? state.projected : false,
      reviewCount: state?.snapshot_hash === hash ? state.review_count : 0,
    };
  });
}
async function finish(
  c: PersonConnection,
  r: any,
  result: Record<string, any>,
  phase: string,
) {
  await c.query(
    "update public.person_directory_receipts set phase=$2,result=$3,error_code=$4,updated_at=clock_timestamp() where id=$1",
    [r.id, phase, result, result.reason ?? null],
  );
  return result;
}
/** Do not rebase historical-v3 clocks implicitly. Exact baseline snapshots
 * retain their owners. Changed unprovable components remain in the receipt
 * for review while unrelated safe contacts/workflow can be admitted. */
async function admittedDocuments(c: PersonConnection, r: any, id: string) {
  if (r.documents)
    return {
      docs: r.documents as PersonDoc[],
      reviews: r.source_reviews as any[],
    };
  const s = r.snapshot as DirectorySnapshot,
    all = directoryDocuments(s, id);
  const sources = (
    await c.query(
      "select * from public.candidate_sources where candidate_id=$1 and source='directory' and source_ref=$2",
      [id, s.board.contact_id],
    )
  ).rows;
  const baseline = fromDirectory(
    s.board,
    s.harvest,
    s.exps,
    s.edus,
    s.emails,
    s.phones,
    id,
  );
  const exact = sources.some(
    (x) =>
      x.payload_hash === baseline.source.payload_hash &&
      x.parser_version === baseline.source.parser_version &&
      new Date(x.fetched_at).toISOString() === baseline.source.fetched_at,
  );
  const state = (
    await c.query(
      "select header from public.candidate_profile_state where candidate_id=$1",
      [id],
    )
  ).rows[0];
  const prior = (
    await c.query(
      "select snapshot,source_reviews from public.person_directory_receipts where candidate_id=$1 and id<$2 and documents is not null order by id desc limit 1",
      [id, r.id],
    )
  ).rows[0];
  const reviews = new Map<string, any>(
    (prior?.source_reviews ?? []).map((x: any) => [x.component, x]),
  );
  const hold = (component: string, reason: string) =>
    reviews.set(component, { component, reason });
  for (const d of all)
    for (const contact of d.contacts)
      if (contact.source_detail === "directory_contact_chronology")
        hold(
          `email:${contact.value_normalized}`,
          "directory_contact_chronology",
        );
  const previous = new Map(
    prior
      ? directoryDocuments(prior.snapshot, id).map((d) => [
          d.source.source_ref,
          d,
        ])
      : [],
  );
  const docs = all.filter((d) => {
    const ref = d.source.source_ref!,
      old = previous.get(ref);
    const history = ref.endsWith(":harvest"),
      board = ref.includes(":board:");
    if ((history || board) && exact) return false;
    // An unchanged rejected component is still rejected, not an accepted
    // predecessor. Its scoped review remains until proven newer input arrives.
    if (
      (history || board) &&
      old?.source.payload_hash === d.source.payload_hash
    )
      return false;
    if (
      history &&
      ((old && d.source.fetched_at <= old.source.fetched_at) ||
        (!prior &&
          sources.some(
            (x) => new Date(x.fetched_at).toISOString() >= d.source.fetched_at,
          )))
    ) {
      hold("harvest", "directory_history_chronology");
      return false;
    }
    if (history) reviews.delete("harvest");
    if (board) {
      const field = Object.keys(d.header).find(
        (k) => d.header[k as keyof typeof d.header] != null,
      )!;
      const current = state?.header?.[field];
      if (current?.value === d.header[field as keyof typeof d.header])
        return false;
      const baselineBlocked =
        current &&
        sources.some((x) => x.id === current.source_id) &&
        d.source.fetched_at <= new Date(current.at).toISOString();
      if (
        current &&
        (d.mode === "fill_gaps" ||
          baselineBlocked ||
          (old && d.source.fetched_at <= old.source.fetched_at))
      ) {
        hold(field, "directory_header_chronology");
        return false;
      }
      if (!current || d.source.fetched_at > new Date(current.at).toISOString())
        reviews.delete(field);
    }
    return true;
  });
  if (!docs.length) docs.push(all[0]);
  return { docs, reviews: [...reviews.values()] };
}
export async function saveDirectoryOnConnection(
  c: PersonConnection,
  a: Scope & { receiptId: string | number; mode: "shadow" | "live" },
) {
  if (!["shadow", "live"].includes(a.mode))
    throw Error("person_directory_mode");
  return tx(c, a, async () => {
    const peek = (
      await c.query(
        "select * from public.person_directory_receipts where id=$1",
        [a.receiptId],
      )
    ).rows[0];
    if (!peek) throw Error("person_directory_receipt");
    const s = peek.snapshot as DirectorySnapshot,
      ids = directoryIdentities(s),
      usernames = ids
        .filter((x) => x.kind === "linkedin_username")
        .map((x) => x.value)
        .sort();
    for (const username of usernames)
      await c.query("select pg_advisory_xact_lock(72007,hashtext($1))", [
        username,
      ]);
    // All additional strong identities also serialize admission, including two
    // directory records with different usernames sharing an Airtable/URN key.
    for (const key of ids
      .filter((x) => x.kind !== "linkedin_username")
      .map((x) => `${x.kind}:${x.value}`)
      .sort())
      await c.query("select pg_advisory_xact_lock(72012,hashtext($1))", [key]);
    await c.query("select pg_advisory_xact_lock(72011,hashtext($1))", [
      peek.contact_id,
    ]);
    const r = (
      await c.query(
        "select * from public.person_directory_receipts where id=$1 for update",
        [peek.id],
      )
    ).rows[0];
    const state = (
      await c.query(
        "select * from public.person_directory_state where contact_id=$1 for update",
        [r.contact_id],
      )
    ).rows[0];
    if (String(state?.latest_receipt_id) !== String(r.id))
      return finish(c, r, { status: "superseded" }, "superseded");
    const owners = (
      await c.query(
        `select id from public.candidates where lower(linkedin_username)=any($1::text[]) or directory_contact_id=$2 or airtable_id=any($3::text[])
   union select candidate_id id from public.candidate_identities i join jsonb_to_recordset($4::jsonb) x(kind text,value text) on i.kind=x.kind and i.value=x.value`,
        [
          usernames,
          r.contact_id,
          ids.filter((x) => x.kind === "airtable_id").map((x) => x.value),
          JSON.stringify(ids),
        ],
      )
    ).rows;
    const ownerIds = [
      ...new Set([
        ...owners.map((x) => x.id),
        ...(r.candidate_id ? [r.candidate_id] : []),
      ]),
    ];
    if (ownerIds.length > 1)
      return finish(
        c,
        r,
        { status: "review", reason: "directory_identity_conflict" },
        "review",
      );
    let id = ownerIds[0],
      created = r.created_person;
    const suppressed =
      s.board.do_not_contact === true || s.board.status === "Do Not Contact";
    if (!id && suppressed)
      return finish(
        c,
        r,
        { status: "suppressed", candidateId: null, created: false },
        "suppressed",
      );
    if (!id && !usernames.length)
      return finish(
        c,
        r,
        { status: "review", reason: "directory_linkedin_required" },
        "review",
      );
    if (!id) {
      id = randomUUID();
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [id]);
      await c.query(
        "insert into public.candidates(id,full_name,linkedin_username,linkedin_url,source,status) values($1,$2,$3,$4,'directory','engaged')",
        [
          id,
          s.board.name || directoryCanonicalUsername(s),
          directoryCanonicalUsername(s),
          `https://www.linkedin.com/in/${encodeURIComponent(directoryCanonicalUsername(s)!)}`,
        ],
      );
      created = true;
    }
    const before = await lockPerson(c, id);
    if (
      before.directory_contact_id &&
      before.directory_contact_id !== r.contact_id
    )
      return finish(
        c,
        r,
        { status: "review", reason: "directory_linkage_conflict" },
        "review",
      );
    await c.query(
      "update public.person_directory_receipts set candidate_id=$2,created_person=$3,attempts=attempts+1 where id=$1",
      [r.id, id, created],
    );
    if (suppressed) {
      await c.query(
        "update public.candidates set status='Do Not Contact',updated_at=clock_timestamp() where id=$1 and status is distinct from 'Do Not Contact'",
        [id],
      );
      return finish(
        c,
        r,
        { status: "suppressed", candidateId: id, created },
        "suppressed",
      );
    }
    if (
      !created &&
      !(
        await c.query(
          "select 1 from public.candidate_profile_state where candidate_id=$1",
          [id],
        )
      ).rows.length
    )
      return finish(
        c,
        r,
        {
          status: "review",
          candidateId: id,
          reason: "directory_person_not_migrated",
        },
        "review",
      );
    if (
      (
        await c.query(
          "select 1 from public.person_source_holds where candidate_id=$1 and resolved_at is null limit 1",
          [id],
        )
      ).rows.length
    )
      return finish(
        c,
        r,
        { status: "review", candidateId: id, reason: "directory_source_hold" },
        "review",
      );
    const { docs, reviews } = await admittedDocuments(c, r, id);
    const saved = await savePersonLocked(c, docs, { mode: "shadow" }, before);
    // Writers predating this intake do not all share the admission locks. The
    // unique identity constraint serializes their inserts; verify acquisition
    // after save_person, which intentionally reports identity_taken as review.
    const acquired = (
      await c.query(
        `select i.candidate_id from jsonb_to_recordset($1::jsonb) x(kind text,value text) left join public.candidate_identities i on i.kind=x.kind and i.value=x.value`,
        [JSON.stringify(ids)],
      )
    ).rows;
    if (
      acquired.length !== ids.length ||
      acquired.some((x) => x.candidate_id !== id)
    )
      throw Error("directory_identity_conflict");
    const primary = directoryPrimary(s),
      oldChoice = (
        await c.query(
          "select chosen_value from public.person_directory_primary where candidate_id=$1 and kind='email'",
          [id],
        )
      ).rows[0];
    const changedChoice = !oldChoice || oldChoice.chosen_value !== primary;
    await c.query(
      "insert into public.person_directory_primary(candidate_id,kind,directory_contact_id,chosen_value,receipt_id) values($1,'email',$2,$3,$4) on conflict(candidate_id,kind) do update set chosen_value=excluded.chosen_value,receipt_id=excluded.receipt_id where person_directory_primary.receipt_id<=excluded.receipt_id",
      [id, r.contact_id, primary, r.id],
    );
    if (changedChoice) {
      await c.query("select public.person_rerank_contacts($1)", [id]);
      await c.query(
        "update public.candidate_profile_state set rev=rev+1,updated_at=clock_timestamp() where candidate_id=$1",
        [id],
      );
    }
    const result = await savePersonLocked(
      c,
      [docs[0]],
      { mode: created ? "live" : a.mode },
      before,
    );
    if (a.mode === "live" || created) {
      // Only a source actually saved with this exact content and original date
      // can advance enrichment metadata. A retained review snapshot cannot.
      const historical = fromDirectory(
        s.board,
        s.harvest,
        s.exps,
        s.edus,
        s.emails,
        s.phones,
        id,
      );
      const harvestDoc = directoryDocuments(s, id).find((d) =>
        d.source.source_ref?.endsWith(":harvest"),
      );
      const witnesses = [historical, ...(harvestDoc ? [harvestDoc] : [])].map(
        (d) => d.source,
      );
      const proven =
        isoOf(s.harvest?.fetched_at) &&
        (
          await c.query(
            `select 1 from public.candidate_sources cs join jsonb_to_recordset($2::jsonb) w(source_ref text,payload_hash text,parser_version text,fetched_at timestamptz) on cs.source_ref=w.source_ref and cs.payload_hash=w.payload_hash and cs.parser_version=w.parser_version and cs.fetched_at=w.fetched_at where cs.candidate_id=$1 and cs.source='directory' limit 1`,
            [id, JSON.stringify(witnesses)],
          )
        ).rows.length > 0;
      const admittedAt = proven ? isoOf(s.harvest?.fetched_at) : null;
      const profile = (
        await c.query("select * from public.candidates where id=$1", [id])
      ).rows[0];
      const years = poolSignals({
        ...profile,
        calculated_experience_years: null,
        total_experience_years: null,
      }).years;
      const calculatedYears = Number.isFinite(years)
        ? Math.round(years!)
        : null;
      await c.query(
        "update public.candidates set calculated_experience_years=$2::numeric where id=$1 and $2::numeric is not null and calculated_experience_years is distinct from $2::numeric",
        [id, calculatedYears],
      );
      // Curated contact JSON and a recruiter-entered follow-up remain intact.
      // Suppression is sticky; ordinary directory status never reactivates it.
      await c.query(
        `update public.candidates set directory_contact_id=$2,directory_sync_hash=$3,source='directory',status=case when status='Do Not Contact' then status else $4 end,follow_up_at=coalesce(follow_up_at,$5::date),linkedin_enrichment_date=case when $6::timestamptz is null then linkedin_enrichment_date else greatest(linkedin_enrichment_date,$6::timestamptz) end,updated_at=clock_timestamp() where id=$1 and
    (directory_contact_id,directory_sync_hash,source,status,follow_up_at,linkedin_enrichment_date) is distinct from
    ($2::uuid,$3::text,'directory'::text,case when status='Do Not Contact' then status else $4::text end,coalesce(follow_up_at,$5::date),case when $6::timestamptz is null then linkedin_enrichment_date else greatest(linkedin_enrichment_date,$6::timestamptz) end)`,
        [
          id,
          r.contact_id,
          r.snapshot_hash,
          s.board.status || "engaged",
          isoOf(s.board.follow_up_date)?.slice(0, 10) ?? null,
          admittedAt,
        ],
      );
    }
    if(a.mode === 'live')
      await enqueuePersonDerivativesLocked(c,{organizationId:TT_ORG_ID,candidateId:id,receiptRef:`directory:${r.id}`});
    const canonical = (
      await c.query("select * from public.candidates where id=$1", [id])
    ).rows[0];
    const pending =
      (
        await c.query(
          "select 1 from public.person_directory_receipts where candidate_id=$1 and derivative_text=$2 and not derivative_done and id<>$3 limit 1",
          [id, matchingText(canonical), r.id],
        )
      ).rows.length > 0;
    if (
      (a.mode === "live" || created) &&
      (pending ||
        created ||
        !before.matching_embedding ||
        matchingText(before) !== matchingText(canonical))
    )
      await c.query(
        `update public.person_directory_receipts set derivative_text=$2,derivative_revision=$3 where id=$1 and derivative_text is null`,
        [r.id, matchingText(canonical), result.revision],
      );
    const out = {
      status: "done",
      candidateId: id,
      created,
      revision: result.revision,
      semanticChanged: result.semanticChanged,
      projected: result.projected,
      reviewCount: reviews.length,
      changed: saved.changed || changedChoice || result.changed,
    };
    await c.query(
      "update public.person_directory_receipts set documents=$2,source_reviews=$3,projected=projected or $4 where id=$1",
      [
        r.id,
        JSON.stringify(docs),
        JSON.stringify(reviews),
        a.mode === "live" || created,
      ],
    );
    await c.query(
      "update public.person_directory_state set applied_receipt_id=$2 where contact_id=$1",
      [r.contact_id, r.id],
    );
    return finish(c, r, out, "done");
  }).catch(async (error) => {
    if ((error as Error).message !== "directory_identity_conflict") throw error;
    // Rollback above removes any new person/profile. The independently staged
    // input survives and receives its review result in a fresh transaction.
    return tx(c, a, async () => {
      const r = (
        await c.query(
          "select * from public.person_directory_receipts where id=$1 for update",
          [a.receiptId],
        )
      ).rows[0];
      if (!r) throw error;
      return finish(
        c,
        r,
        { status: "review", reason: "directory_identity_conflict" },
        "review",
      );
    });
  });
}
export const claimDirectoryScan = (a: Scan) =>
  withPersonConnection((c) => claimDirectoryScanOnConnection(c, a));
export const stageDirectory = (a: Lease & { snapshot: DirectorySnapshot }) =>
  withPersonConnection((c) => stageDirectoryOnConnection(c, a));
export const saveDirectory = (
  a: Scope & { receiptId: string | number; mode: "shadow" | "live" },
) => withPersonConnection((c) => saveDirectoryOnConnection(c, a));
export const checkpointDirectoryScan = (
  a: Lease & { cursor: string; release?: boolean; complete?: boolean },
) => withPersonConnection((c) => checkpointDirectoryScanOnConnection(c, a));

export async function claimDirectoryEmbeddingOnConnection(
  c: PersonConnection,
  a: Scope & { receiptId: string | number },
) {
  return tx(c, a, async () => {
    const r = (
      await c.query(
        "select *,derivative_lease_until>clock_timestamp() active from public.person_directory_receipts where id=$1 for update",
        [a.receiptId],
      )
    ).rows[0];
    if (!r || !r.projected || !r.derivative_text || r.derivative_done)
      return { status: "done" as const };
    if (r.active) return { status: "busy" as const };
    if (r.derivative_attempts >= 3) return { status: "review" as const };
    const person = await lockPerson(c, r.candidate_id);
    const state = (
      await c.query(
        "select rev from public.candidate_profile_state where candidate_id=$1",
        [r.candidate_id],
      )
    ).rows[0];
    if (
      String(state?.rev) !== String(r.derivative_revision) ||
      matchingText(person) !== r.derivative_text
    ) {
      await c.query(
        "update public.person_directory_receipts set derivative_done=true,derivative_error='stale_profile' where id=$1",
        [r.id],
      );
      return { status: "stale" as const };
    }
    const token = randomUUID();
    await c.query(
      "update public.person_directory_receipts set derivative_token=$2,derivative_attempts=derivative_attempts+1,derivatives_claimed_at=clock_timestamp(),derivative_lease_until=clock_timestamp()+interval '10 minutes' where id=$1",
      [r.id, token],
    );
    return { status: "claimed" as const, token, text: r.derivative_text };
  });
}
export async function saveDirectoryEmbeddingOnConnection(
  c: PersonConnection,
  a: Scope & { receiptId: string | number; token: string; vector: number[] },
) {
  scope(a);
  if (
    !Array.isArray(a.vector) ||
    a.vector.length !== 1536 ||
    a.vector.some((x) => !Number.isFinite(x))
  )
    throw Error("person_directory_vector");
  return tx(c, a, async () => {
    const r = (
      await c.query(
        "select * from public.person_directory_receipts where id=$1 for update",
        [a.receiptId],
      )
    ).rows[0];
    if (!r || r.derivative_token !== a.token)
      throw Error("person_directory_derivative_token");
    if (r.derivative_done) return { status: "done" };
    const person = await lockPerson(c, r.candidate_id);
    const state = (
      await c.query(
        "select rev from public.candidate_profile_state where candidate_id=$1",
        [r.candidate_id],
      )
    ).rows[0];
    const latest = (
      await c.query(
        "select latest_receipt_id from public.person_directory_state where contact_id=$1",
        [r.contact_id],
      )
    ).rows[0];
    const stale =
      String(state?.rev) !== String(r.derivative_revision) ||
      matchingText(person) !== r.derivative_text ||
      String(latest?.latest_receipt_id) !== String(r.id);
    if (!stale)
      await c.query(
        "update public.candidates set matching_embedding=$2::vector,embedding_type='directory' where id=$1",
        [r.candidate_id, JSON.stringify(a.vector)],
      );
    await c.query(
      "update public.person_directory_receipts set derivative_done=true,derivative_lease_until=null,derivative_error=$2 where id=$1",
      [r.id, stale ? "stale_profile" : null],
    );
    return { status: stale ? "stale" : "saved" };
  });
}
export const claimDirectoryEmbedding = (
  a: Scope & { receiptId: string | number },
) => withPersonConnection((c) => claimDirectoryEmbeddingOnConnection(c, a));
export const saveDirectoryEmbedding = (
  a: Scope & { receiptId: string | number; token: string; vector: number[] },
) => withPersonConnection((c) => saveDirectoryEmbeddingOnConnection(c, a));
export const pendingDirectoryEmbeddings = (a: Scan & { limit: number }) =>
  withPersonConnection((c) => {
    scope(a);
    if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 50)
      throw Error("person_directory_derivative_limit");
    return c
      .query(
        `select r.id from public.person_directory_receipts r join public.person_directory_state s on s.latest_receipt_id=r.id where r.workspace_id=$1 and r.projected and r.derivative_text is not null and not r.derivative_done and r.derivative_attempts<3 and (r.derivative_lease_until is null or r.derivative_lease_until<clock_timestamp()) order by r.id limit $2`,
        [a.workspaceId, a.limit],
      )
      .then((r) => r.rows.map((x) => String(x.id)));
  });

/** One bounded round trip for unchanged snapshots, not one transaction per
 * person on every full scan. Changed/ready/review inputs still use staging. */
export async function inspectDirectoryPageOnConnection(
  c: PersonConnection,
  a: Lease & { snapshots: DirectorySnapshot[] },
) {
  if (a.snapshots.length > 100) throw Error("person_directory_page_limit");
  const items = a.snapshots.map((snapshot) => ({
    contact_id: snapshot.board.contact_id,
    snapshot_hash: directorySnapshotHash(snapshot),
  }));
  return tx(c, a, async () => {
    const scan = await scanRow(c, a);
    const rows = (
      await c.query(
        `select s.contact_id,r.id,r.phase,r.projected,jsonb_array_length(r.source_reviews) review_count
   from jsonb_to_recordset($1::jsonb) x(contact_id uuid,snapshot_hash text)
   join public.person_directory_state s on s.contact_id=x.contact_id and s.workspace_id=$2
   join public.person_directory_receipts r on r.id=s.latest_receipt_id and r.snapshot_hash=x.snapshot_hash and r.phase='done'`,
        [JSON.stringify(items), a.workspaceId],
      )
    ).rows;
    if (rows.length)
      await c.query(
        "update public.person_directory_state set seen_cycle=$3 where contact_id=any($1::uuid[]) and workspace_id=$2 and seen_cycle<>$3",
        [rows.map((x) => x.contact_id), a.workspaceId, scan.cycle],
      );
    return rows.map((x) => ({
      contactId: x.contact_id,
      receiptId: String(x.id),
      phase: x.phase,
      projected: x.projected,
      reviewCount: x.review_count,
    }));
  });
}
export const inspectDirectoryPage = (
  a: Lease & { snapshots: DirectorySnapshot[] },
) => withPersonConnection((c) => inspectDirectoryPageOnConnection(c, a));

export async function pendingDirectoryReceiptsOnConnection(
  c: PersonConnection,
  a: Lease & { limit: number },
) {
  if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 100)
    throw Error("person_directory_recovery_limit");
  return tx(c, a, async () => {
    await scanRow(c, a);
    return (
      await c.query(
        `select r.id from public.person_directory_receipts r join public.person_directory_state s on s.latest_receipt_id=r.id where r.workspace_id=$1 and r.phase='ready' order by r.id limit $2`,
        [a.workspaceId, a.limit],
      )
    ).rows.map((x) => String(x.id));
  });
}
export const pendingDirectoryReceipts = (a: Lease & { limit: number }) =>
  withPersonConnection((c) => pendingDirectoryReceiptsOnConnection(c, a));
