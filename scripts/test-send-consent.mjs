#!/usr/bin/env node
// Send consent and duplicates test.
//
// Builds the leak test's throwaway companies (scripts/tenancy/fixture.mjs):
// a Transformer Talent job linked to company A's job 9001, which is open with
// help switched on, and TT's own copy of the job closed. Then, as the TT test
// login, calls the real Send endpoint the way the Network tab does and checks:
//
//   1. a send works (200): one application in A, TT's tag and reason mirrored
//      onto A's job and nothing of TT's own notes with it
//   2. the same person again is "already sent" (409), still one application;
//      if A's copy of the tag and reason went missing, that repeat puts it back
//   3. A switches off help: a send of another pool person is refused (422)
//      and writes nothing
//   4. help back on but A closed the job: still refused (422), nothing written
//   5. A reopens the job: the send works (200)
//   6. several sends of one person at the same moment make one application,
//      and the database itself refuses a second copy (migration 071)
//   7. the link between TT's job and A's job is still there
//
// Everything it created is deleted at the end, pass or fail.
//
//   node scripts/test-send-consent.mjs --base https://transformer-talent-preview.vercel.app
//
// Needs .env.scripts with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
// SUPABASE_ANON_KEY, and migration 071 applied (check 6 fails without it).
// Leftovers of a crashed run: node scripts/test-tenancy.mjs --cleanup
import { newRun, setup, teardown, leftovers, svc } from "./tenancy/fixture.mjs";

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i > -1 ? args[i + 1] : null;
};
const BASE = (opt("--base") || "").replace(/\/$/, "");
if (!/^https?:\/\//.test(BASE)) {
  console.error("usage: node scripts/test-send-consent.mjs --base <deployment url>");
  process.exit(1);
}

const results = []; // { ok, name, detail }
const check = (name, ok, detail = "") => {
  results.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  ->  ${detail}` : ""}`);
};

/** One dashboard API call as a test login. Only the status and the error code are ever printed. */
async function api(login, method, path, body) {
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${login.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json };
  } catch (e) {
    return { status: -1, json: null, error: e.message };
  }
}
const said = (r) => `${r.status}${r.json?.error ? ` ${r.json.error}` : ""}${r.error ? ` ${r.error}` : ""}`;

const run = newRun();
let W = null;
try {
  console.log(`run ${run.id} against ${BASE}`);
  W = await setup(run);
  const { A, B, TT } = W;
  const send = (candidateId, jobId) => api(TT.login, "POST", "/api/dashboard/network/send", { candidateId, jobId });
  const appsIn = async (org, candidateId) =>
    (await svc(`website_applications?organization_id=eq.${org.id}&candidate_id=eq.${candidateId}&select=id`)).length;
  const aJob = async () => (await svc(`org_roles?id=eq.${A.role.id}&select=status,sourcing_requested`))[0];

  // 1. The send the Network tab makes.
  const first = await send(TT.sent.id, run.ttJob);
  check("1. send works (200)", first.status === 200 && !!first.json?.applicationId, said(first));
  const n1 = await appsIn(A.org, TT.sent.id);
  check("1. A's pipeline has one application", n1 === 1, `${n1} applications`);
  const mirrors = await svc(
    `match_verdicts?organization_id=eq.${A.org.id}&candidate_id=eq.${TT.sent.id}&org_role_id=eq.${A.role.id}&select=model,source,verdict`
  );
  check("1. the tag and reason are mirrored onto A's job", mirrors.length === 1 && mirrors[0].model === null && mirrors[0].source === "referral", `${mirrors.length} mirror rows`);
  check("1. the mirror carries nothing of TT's own", mirrors.length > 0 && mirrors.every((m) => !JSON.stringify(m.verdict).includes(run.tokens.t)), "a TT-private marker crossed to A");

  // 2. The same person again (a second tab, a double click after a reload).
  const again = await send(TT.sent.id, run.ttJob);
  check("2. second send of the same person is already sent (409)", again.status === 409 && again.json?.error === "already_sent", said(again));
  const n2 = await appsIn(A.org, TT.sent.id);
  check("2. still one application", n2 === 1, `${n2} applications`);

  // 2b. A mirror lost after the application was written: the repeat send
  // is still "already sent", and it puts the tag and reason back.
  const mirrorOnA = `match_verdicts?organization_id=eq.${A.org.id}&candidate_id=eq.${TT.sent.id}&org_role_id=eq.${A.role.id}`;
  await svc(mirrorOnA, { method: "DELETE", prefer: "return=minimal" });
  const heal = await send(TT.sent.id, run.ttJob);
  check("2b. a send after the mirror was lost is still already sent (409)", heal.status === 409 && heal.json?.error === "already_sent", said(heal));
  const healed = await svc(`${mirrorOnA}&select=model,source,verdict`);
  check("2b. the lost mirror is put back, once", healed.length === 1 && healed[0].model === null && healed[0].source === "referral", `${healed.length} mirror rows`);
  check("2b. the put-back mirror carries nothing of TT's own", healed.length > 0 && healed.every((m) => !JSON.stringify(m.verdict).includes(run.tokens.t)), "a TT-private marker crossed to A");

  // 3. A switches off help on its job screen.
  const off = await api(A.login, "PATCH", "/api/dashboard/jobs/9001", { sourcingRequested: false });
  const offState = await aJob();
  check("3. setup: A switched off help", off.status === 200 && offState?.sourcing_requested === false, said(off));
  const r3 = await send(TT.unsent.id, run.ttJob);
  check("3. send after help is off is refused (422)", r3.status === 422 && r3.json?.error === "client_not_requesting", said(r3));
  const n3 = await appsIn(A.org, TT.unsent.id);
  check("3. nothing was written", n3 === 0, `${n3} applications`);

  // 4. Help back on, job closed. Help is switched on directly: through A's
  // job screen it would email Spencer that a test company asked for help.
  await svc(`org_roles?id=eq.${A.role.id}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({ sourcing_requested: true, sourcing_requested_at: new Date().toISOString() }),
  });
  const closed = await api(A.login, "PATCH", "/api/dashboard/jobs/9001", { status: "closed" });
  const closedState = await aJob();
  check("4. setup: help on, A closed the job", closed.status === 200 && closedState?.status === "closed" && closedState?.sourcing_requested === true, said(closed));
  const r4 = await send(TT.unsent.id, run.ttJob);
  check("4. send to a closed job is refused (422)", r4.status === 422 && r4.json?.error === "client_not_requesting", said(r4));
  const n4 = await appsIn(A.org, TT.unsent.id);
  check("4. nothing was written", n4 === 0, `${n4} applications`);

  // 5. A reopens the job: sends work again.
  const reopened = await api(A.login, "PATCH", "/api/dashboard/jobs/9001", { status: "open" });
  const openState = await aJob();
  check("5. setup: A reopened the job", reopened.status === 200 && openState?.status === "open" && openState?.sourcing_requested === true, said(reopened));
  const r5 = await send(TT.unsent.id, run.ttJob);
  check("5. send after restoring works (200)", r5.status === 200 && !!r5.json?.applicationId, said(r5));
  const n5 = await appsIn(A.org, TT.unsent.id);
  check("5. one application", n5 === 1, `${n5} applications`);

  // 6. Several sends at the same moment, to B's linked job: they can all
  // pass the lookup, so only the unique index keeps the extra copies out.
  const burst = await Promise.all([1, 2, 3, 4].map(() => send(TT.second.id, run.ttJob2)));
  const worked = burst.filter((r) => r.status === 200).length;
  const refused = burst.filter((r) => r.status === 409 && r.json?.error === "already_sent").length;
  check("6. four sends at once: one works, three are already sent", worked === 1 && refused === 3, burst.map(said).join(", "));
  const n6 = await appsIn(B.org, TT.second.id);
  check("6. one application", n6 === 1, `${n6} applications`);
  // The race above is not certain to happen, so the index is also asked
  // directly: a second copy written straight to the table must be refused.
  let dup = "written";
  try {
    await svc("website_applications", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({
        organization_id: B.org.id,
        name: `Duplicate ${run.tokens.r}-dup`,
        email: "",
        role_ids: ["9001"],
        role_titles: ["duplicate (#9001)"],
        status: "processed",
        source: "transformer_talent",
        candidate_id: TT.second.id,
      }),
    });
  } catch (e) {
    dup = /\b409\b/.test(e.message) && e.message.includes("23505") ? "refused" : `failed otherwise: ${e.message.slice(0, 120)}`;
  }
  check("6. the database refuses a second copy (migration 071)", dup === "refused", dup === "written" ? "a duplicate row was written: is migration 071 applied?" : dup);

  // 7. A refusal never unlinks: the link is TT's wiring, the client's switch is consent.
  const [ttRole] = await svc(`org_roles?id=eq.${TT.role.id}&select=linked_org_role`);
  check("7. the link to A's job stays", ttRole?.linked_org_role?.orgId === A.org.id && ttRole?.linked_org_role?.jobId === "9001", JSON.stringify(ttRole?.linked_org_role ?? null));
} catch (e) {
  check("test run", false, `crashed: ${e.message}`);
} finally {
  const td = await teardown({ runId: run.id }).catch((e) => ({ error: e.message }));
  const left = await leftovers(run.id).catch(() => ["(leftover check failed)"]);
  console.log(`cleanup: ${JSON.stringify(td)}${left.length ? ` LEFTOVERS: ${left.join("; ")}` : " (nothing left)"}`);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAIL: ${failed.length} of ${results.length} checks failed.` : `\nPASS: all ${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
