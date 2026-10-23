// The post-cutover audit planner. Pure: takes one person's evidence snapshot
// (person_postcutover_audit_inputs_with_witness) and decides verified, pending
// or review, with the reasons. It never reads or writes a database.
//
// verified: the immutable anchor is valid; every candidate change since the
//   anchor is exactly attributed to an audited operation; every stored
//   normalized source is owned by the frozen legacy document or an admitted
//   receipt; every admitted receipt is stored; the stored rows pass the
//   trial's integrity checks against that exact document set; a published
//   profile still matches its projection; the directory has nothing pending.
// pending: a raw fact or receipt exists that no writer has admitted yet.
// review: anything that cannot be explained from the evidence. No repair.
import {collectEvidence,sameSource as witnessedSource,same,sentApplication} from "./evidence.mjs";
import {creationEvidence,metadataEvidence} from './mutations.mjs';
import {exactStored} from "./integrity.mjs";
import {attributionReferences} from "./references.mjs";
import { createHash } from "node:crypto";
import { Tally, checkStored, stable } from "../person-trial.mjs";

const hashOf = (v) => createHash("md5").update(JSON.stringify(stable(v))).digest("hex");
const arr = (v) => (Array.isArray(v) ? v : []);
const sameSource = witnessedSource;
const sortedEq = (a, b) => JSON.stringify([...arr(a)].sort()) === JSON.stringify([...arr(b)].sort());

/** Documents whose facts may legitimately be in normalized storage. */
export function expectedDocuments(snapshot) {
  const docs = [];
  const add = (doc, owner) => { if (doc && typeof doc === "object" && doc.source) docs.push({ doc, owner }); };
  if (snapshot.anchor?.kind === "legacy") add(snapshot.anchor.legacy_doc, "anchor");
  for (const r of arr(snapshot.application_receipts)) for (const d of arr(r.documents)) add(d, `application:${r.application_id}`);
  for (const r of arr(snapshot.refresh_receipts)) if (r.phase === "done") for (const d of arr(r.documents)) add(d, `refresh:${r.queue_id}`);
  for (const r of arr(snapshot.directory_receipts)) if (r.phase === "done" && r.candidate_id === snapshot.candidate_id) for (const d of arr(r.documents)) add(d, `directory:${r.id}`);
  for (const r of arr(snapshot.recruiter_receipts)) if (r.result && r.result.status !== "failed") add(r.document, `recruiter:${r.id}`);
  // Generic anchored saves retain their exact documents in operation evidence.
  for (const o of arr(snapshot.operations)) if (["projection", "undo"].includes(o.writer)) for (const d of arr(o.evidence?.documents)) add(d, `operation:${o.id}`);
  return docs;
}

function candidateChain(snapshot, scopes, guardVersion, lib, out) {
  const anchor = snapshot.anchor;
  const events = arr(snapshot.events).filter((e) => e.source_table === "candidates").sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
  const opById = new Map(arr(snapshot.operations).map((o) => [o.id, o]));
  let current = snapshot.anchor_contract_hash;
  let start = BigInt(anchor.captured_version);
  if (anchor.kind === "receipt_created") {
    const creatorId = anchor.external_proof?.creator_event_id;
    const creator = events.find((e) => e.id === String(creatorId));
    if (!creator || creator.operation !== "INSERT" || creator.after_contract_hash !== snapshot.anchor_contract_hash) return out.review("creation_event");
    const a = creator.attribution;
    const op = a && opById.get(a.operation_id);
    if (!a || a.scope !== "creation" || a.event_hash !== creator.actual_event_hash || !op || !["application", "directory"].includes(op.writer) || op.receipt_ref !== anchor.creator_ref) return out.review("creation_event");
    if(!creationEvidence(snapshot,creator,op,lib))return out.review('creation_evidence_invalid');
    out.checks.creation_event = true;
  }
  let attributed = 0, unchanged = 0;
  for (const e of events) {
    if (BigInt(e.id) <= start) continue;
    if (e.operation !== "UPDATE" || e.source_row_id !== snapshot.candidate_id) return out.review("event_chain");
    if (e.before_contract_hash !== current) return out.review("event_chain");
    if (e.before_contract_hash === e.after_contract_hash) { unchanged++; current = e.after_contract_hash; continue; }
    const a = e.attribution;
    if (!a) return out.review("unattributed_change");
    const rule = scopes[a.scope];
    const op = opById.get(a.operation_id);
    if (!rule || a.scope === "creation" || a.candidate_id !== snapshot.candidate_id || !op || op.candidate_id !== snapshot.candidate_id) return out.review("attribution_invalid");
    if (a.event_hash !== e.actual_event_hash || !sortedEq(a.changed_fields, e.actual_changed_fields)) return out.review("attribution_invalid");
    if (arr(e.actual_changed_fields).some((k) => !rule.fields.includes(k)) || (rule.writer && rule.writer !== op.writer)) return out.review("attribution_invalid");
    if (op.transaction_id !== e.transaction_id || op.evidence?.guard?.anchor_hash !== anchor.anchor_hash || op.evidence?.guard?.version !== guardVersion) return out.review("attribution_invalid");
    if (a.event_id !== e.id || e.candidate_id !== snapshot.candidate_id) return out.review("attribution_invalid");
    if(a.scope==='profile'){
      const matching=arr(snapshot.history).filter(h=>h.candidate_id===snapshot.candidate_id);
      if(op.writer==='undo'){
        const h=matching.find(h=>String(h.id)===op.evidence.history_id);
        if(!h||!h.restored_at||lib.projectionProfileHash(e.previous_payload)!==h.after_hash||lib.projectionProfileHash(e.payload)!==lib.projectionProfileHash(h.before_profile))return out.review('undo_history_invalid');
      }else if(!matching.some(h=>lib.projectionProfileHash(h.before_profile)===lib.projectionProfileHash(e.previous_payload)&&h.after_hash===lib.projectionProfileHash(e.payload)))return out.review('projection_history_invalid');
    }
    if(['refresh_metadata','directory_metadata'].includes(a.scope)&&!metadataEvidence(snapshot,e,op,lib))return out.review('metadata_unwitnessed');
    if(a.scope==='recruiter_contact'){
      const r=arr(snapshot.recruiter_receipts).find(r=>`recruiter:${r.id}`===op.receipt_ref);
      if(!r||!same(e.payload.contact,r.requested_contact,lib))return out.review('recruiter_mutation_invalid');
    }
    attributed++;
    current = e.after_contract_hash;
  }
  if (current !== snapshot.candidate_contract_hash) return out.review("event_chain");
  out.checks.candidate_events = { attributed, unchanged };
  return true;
}

function rawFacts(snapshot,lib,out) {
  const id = snapshot.candidate_id;
  const admittedLedgers = new Set([
    ...arr(snapshot.refresh_receipts).filter((r) => r.phase === "done" && r.ledger_id).map((r) => r.ledger_id),
    ...arr(snapshot.application_receipts).filter((r) => r.harvest_ledger_id).map((r) => r.harvest_ledger_id),
  ]);
  const admittedApplications = new Set(arr(snapshot.application_receipts).map((r) => r.application_id));
  const after = arr(snapshot.events).filter((e) => e.source_table !== "candidates" && BigInt(e.id) > BigInt(snapshot.anchor.captured_version));
  let pendingLedgers = 0, pendingApplications = 0;
  for (const e of after) {
    const row = e.payload ?? e.previous_payload ?? {};
    if (row.candidate_id && row.candidate_id !== id) continue;
    switch (e.source_table) {
      case "candidate_emails":
        return out.review("legacy_source_edited");
      case "candidate_communications":
        if([e.payload,e.previous_payload].some(r=>r?.communication_type==='email'&&['bounced','replied'].includes(r.status)))return out.review('communication_source_edited');
        break;
      case "candidate_enrichments":
        if (e.operation === "DELETE") return out.review("ledger_deleted");
        if(e.operation==='UPDATE'){
          const keys=['organization_id','linkedin_username','provider','status','cache_status','raw_payload','created_at'];
          if(keys.some(k=>!same(e.previous_payload?.[k],e.payload?.[k],lib)))return out.review('ledger_edited');
          if(e.previous_payload?.candidate_id&&e.previous_payload.candidate_id!==e.payload?.candidate_id)return out.review('ledger_owner_changed');
          if(e.previous_payload?.candidate_id!==e.payload?.candidate_id&&!admittedLedgers.has(row.id))return out.review('ledger_owner_unproved');
        }
        if (row.provider === "harvest" && row.status === "ok" && e.operation === "INSERT" && !admittedLedgers.has(row.id)) pendingLedgers++;
        break;
      case "website_applications":
        if (e.operation === "DELETE") return out.review("application_deleted");
        if (e.operation === "INSERT" && !admittedApplications.has(row.id) && !sentApplication(snapshot, row, lib, e)) pendingApplications++;
        if (e.operation === "UPDATE") {
          const keys=['candidate_id','pool_created_person','parsed_profile','name','email','contact','organization_id','linkedin_username','created_at','location','source'];
          const changed=keys.filter(k=>!same(e.previous_payload?.[k],e.payload?.[k],lib));
          if(changed.length){
            const a=e.attribution,op=arr(snapshot.operations).find(o=>o.id===a?.operation_id),r=arr(snapshot.application_receipts).find(r=>r.application_id===row.id);
            if(!a||a.scope!=='application_finalize'||a.event_id!==e.id||a.candidate_id!==id||a.event_hash!==e.actual_event_hash||!sortedEq(a.changed_fields,e.actual_changed_fields)||!op||op.writer!=='application'||op.candidate_id!==id||op.transaction_id!==e.transaction_id||op.receipt_ref!==`application:${row.id}`||changed.some(k=>!lib.AUDIT_SCOPES.application_finalize.fields.includes(k))||!r||row.candidate_id!==id||row.pool_created_person!==r.created_person||!same(row.parsed_profile,r.application_snapshot.parsed_profile,lib)||['name','contact'].some(k=>changed.includes(k)&&!same(row[k],r.application_snapshot[k],lib)))return out.review('application_edit_unattributed');
          }
        }
        break;
      default:
        return out.review("event_table");
    }
  }
  out.checks.raw_facts = { events: after.length, pending_ledgers: pendingLedgers, pending_applications: pendingApplications };
  if (pendingLedgers) out.pending("raw_fact_not_admitted");
  if (pendingApplications) out.pending("application_not_admitted");
  return true;
}

function sources(snapshot, expected, out) {
  const stored = arr(snapshot.normalized?.sources);
  const unknown = stored.filter((s) => !expected.some(({ doc }) => sameSource(s, doc.source)));
  if (unknown.length) { out.checks.sources = { stored: stored.length, unknown_owner: unknown.length }; return out.review("source_owner_unknown"); }
  const admittedMissing = expected.filter(({ doc, owner }) => owner !== "anchor" && !stored.some((s) => sameSource(s, doc.source)));
  out.checks.sources = { stored: stored.length, expected: expected.length, not_yet_stored: admittedMissing.length };
  if (admittedMissing.length) out.pending("receipt_not_admitted");
  return true;
}

function integrity(snapshot, docs, lib, out) {
  const id = snapshot.candidate_id, n = snapshot.normalized ?? {};
  const t = {
    state: new Map(n.state ? [[id, n.state]] : []),
    sources: new Map([[id, arr(n.sources)]]),
    sourceById: new Map(arr(n.sources).map((s) => [s.id, s])),
    identities: new Map([[id, arr(n.identities)]]),
    jobs: new Map([[id, arr(n.jobs)]]),
    educations: new Map([[id, arr(n.educations)]]),
    cskills: new Map([[id, arr(n.skills)]]),
    contacts: new Map([[id, arr(n.contacts)]]),
    recruiterPrimary: new Map([[id, arr(snapshot.recruiter_primary)]]),
    summary: new Map(n.summary ? [[id, n.summary]] : []),
    conflicts: arr(n.conflicts),
    companyById: new Map(arr(n.companies).map((c) => [c.id, c])),
    schoolById: new Map(arr(n.schools).map((s) => [s.id, s])),
    skillById: new Map(arr(n.skill_lookup).map((s) => [String(s.id), s])),
  };
  const inp = {
    row: snapshot.anchor.before_image,
    legacy: [], v2: [],
    ledger: arr(snapshot.ledger).filter((l) => l.provider === "harvest" && l.status === "ok"),
    apps: arr(snapshot.applications).filter((a) => !sentApplication(snapshot, a, lib)),
    comms: [], dir: null,
  };
  const tally = new Tally();
  let result;
  try { result = checkStored(tally, id, inp, docs, t, lib); }
  catch (error) { out.checks.integrity_error = "stored_check_failed"; return out.review("integrity_check_failed"); }
  const { _projection, ...checks } = result ?? {};
  out.checks.integrity = { ...checks, failed: [...tally.fail.keys()] };
  if (tally.fail.size) return out.review(`integrity:${[...tally.fail.keys()].sort().join(",")}`);
  return true;
}

function published(snapshot, lib, out) {
  const p = snapshot.projection;
  if (!p) { out.checks.published = "unpublished"; return true; }
  const revOk = String(p.revision) === String(snapshot.normalized?.state?.rev);
  const hashOk = lib.projectionProfileHash(snapshot.candidate) === p.profile_hash;
  out.checks.published = { revision_matches: revOk, profile_hash_matches: hashOk };
  if (!hashOk) return out.review("published_drift");
  if (!revOk) out.pending("publication_pending");
  return true;
}

function directory(snapshot,lib,external,out) {
  const states = arr(snapshot.directory_state);
  const receipts = new Map(arr(snapshot.directory_receipts).map((r) => [String(r.id), r]));
  let pending = 0, review = 0, sourceReviews = 0;
  for (const s of states) {
    const latest = receipts.get(String(s.latest_receipt_id));
    if (latest?.phase === "review") review++;
    else if (String(s.latest_receipt_id) !== String(s.applied_receipt_id) || latest?.phase === "ready") pending++;
    const applied = receipts.get(String(s.applied_receipt_id));
    if (arr(applied?.source_reviews).length) sourceReviews++;
  }
  const links=arr(snapshot.boundary?.directory_epochs);
  if(links.length&&!external?.complete)out.pending('external_unavailable');
  else for(const link of links){
    const current=external?.rows?.get(link.contact_id);
    if(!current){out.pending('external_unavailable');continue;}
    const state=states.find(x=>x.contact_id===link.contact_id),latest=state&&receipts.get(String(state.latest_receipt_id));
    if(!latest||latest.candidate_id!==snapshot.candidate_id||!['done','review'].includes(latest.phase)||latest.snapshot_hash!==lib.directorySnapshotHash(current))out.pending('directory_snapshot_not_admitted');
  }
  out.checks.directory = { linked: states.length, pending, review, source_reviews: sourceReviews };
  if (review || sourceReviews) return out.review("directory_review");
  if (pending) out.pending("directory_pending");
  return true;
}

/** Plan one person. `lib` is the built worker library (scopes, hashes, project). */
export function planAudit(snapshot, lib, external = {complete:false,rows:new Map()}) {
  const id = snapshot.candidate_id;
  const out = {
    candidate_id: id, status: "verified", reason: null, checks: {},
    boundary: null, lookup_ids: [], snapshot_hash: hashOf(snapshot),
    review(reason) { this.status = "review"; this.reason ??= reason; return false; },
    pending(reason) { if (this.status === "verified") { this.status = "pending"; this.reason = reason; } return true; },
  };
  const finish = () => ({ candidate_id: id, status: out.status, reason: out.reason, checks: out.checks, boundary: out.boundary, lookup_ids: out.lookup_ids, snapshot_hash: out.snapshot_hash });
  if (snapshot.status !== "ready") { out.review(snapshot.reason ?? "snapshot_not_ready"); return finish(); }
  out.boundary = { ...snapshot.boundary, lookup_witness: snapshot.lookup_witness ?? null };
  const n = snapshot.normalized ?? {};
  out.lookup_ids = [
    ...arr(n.companies).map((c) => `companies:${c.id}`),
    ...arr(n.schools).map((s) => `schools:${s.id}`),
    ...arr(n.skill_lookup).map((s) => `skills:${s.id}`),
  ].sort();
  const anchor = snapshot.anchor;
  if (!snapshot.anchor_hash_valid || anchor.parser_version !== "person-v3" || !["legacy", "receipt_created"].includes(anchor.kind) || anchor.before_image?.id !== id) { out.review("anchor_invalid"); return finish(); }
  if (arr(snapshot.holds).length) { out.review("source_hold"); return finish(); }
  const aux = snapshot.auxiliary?.proof ?? {};
  // Same rule as the writer guard: every current auxiliary hash must equal the
  // anchor's frozen copy. The anchor may carry more keys (preparation proof,
  // creator event) that the live proof never has.
  if (!Object.keys(aux).length || Object.keys(aux).some((k) => aux[k] !== anchor.external_proof?.[k])) { out.review("auxiliary_changed"); return finish(); }
  out.checks.auxiliary = true;
  const evidence=collectEvidence(snapshot,lib,external,out);if(!evidence)return finish();
  if (!attributionReferences(snapshot,lib,out)) return finish();
  if (!candidateChain(snapshot, lib.AUDIT_SCOPES, lib.AUDIT_GUARD_VERSION, lib, out)) return finish();
  if (!rawFacts(snapshot,lib,out)) return finish();
  const expected = evidence.docs;
  if (!sources(snapshot, expected, out)) return finish();
  if (!n.state) { out.review("normalized_state_missing"); return finish(); }
  if (!integrity(snapshot, expected.map((x) => x.doc), lib, out)) return finish();
  if (!exactStored(snapshot,expected.map(x=>x.doc),lib,out)) return finish();
  if (!published(snapshot, lib, out)) return finish();
  if (!directory(snapshot,lib,external,out)) return finish();
  out.checks.open_conflicts = arr(n.conflicts).filter((c) => c.status === "open").length;
  return finish();
}
