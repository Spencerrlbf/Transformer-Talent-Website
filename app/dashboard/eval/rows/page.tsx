"use client";
// Owner-only: each scorecard row as GPT-4o judged it, beside a second opinion
// from TypeSafe's Jev asked twice. Decides whether Jev should judge rows in
// the product; nothing here changes what the product shows, and nothing is
// stored.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { ROW_MARK, ROW_WORD, type RowStatus, type Tier } from "@/lib/rolecard";

type StoredRow = { id: string; label: string; tier: Tier; gpt: RowStatus; evidence: string; byRule: boolean };
type Person = { membershipId: string; name: string; title: string; linkedinUrl: string | null; label: string; rows: StoredRow[] };
type JevRow = { id: string; status: RowStatus; confidence: number; probabilities: Record<RowStatus, number>; again: { status: RowStatus; confidence: number } | null };
type JevPerson = { membershipId: string; error?: string; detail?: string; ms?: number; inputTokens?: number; model?: string; rows?: JevRow[] };
type Data = { role: { title: string }; run: { id: string; at: string } | null; people: Person[]; keyPresent: boolean; usdPerMillionInput?: number };

const ERR: Record<string, string> = {
  no_key: "TYPESAFE_API_KEY is not set for this environment. Add it in Vercel for Preview, then redeploy.",
  key_rejected: "TypeSafe rejected the key.",
  rate_limited: "TypeSafe is rate limiting. Try again in a minute.",
  no_scorecard: "This role has no scorecard yet. Open the job first.",
  no_profile: "No stored profile.",
  failed: "The call failed.",
};

// GPT-4o, measured on this judge: about 4,000 tokens in and 600 out per person.
const GPT_USD_PER_PERSON = (4000 * 2.5 + 600 * 10) / 1_000_000;

function Mark({ s, dim }: { s: RowStatus; dim?: boolean }) {
  return (
    <span className={`ck-mark b-${s}`} style={dim ? { opacity: 0.55 } : undefined} title={ROW_WORD[s]}>
      {ROW_MARK[s]}
    </span>
  );
}

export default function RowJudgeComparison() {
  const { token } = useDash();
  const [jobId, setJobId] = useState("16");
  const [data, setData] = useState<Data | null>(null);
  const [jev, setJev] = useState<Record<string, JevPerson>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    setJev({});
    const r = await fetch(`/api/dashboard/eval/rows?jobId=${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    if (!r?.ok) return setError(d?.error === "owner_only" ? "Owners only." : d?.error === "role_not_found" ? "No job with that number." : "Could not load.");
    setData(d);
  }, [jobId, token]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    if (!data) return;
    setBusy(true);
    setError("");
    const todo = data.people.filter((p) => !jev[p.membershipId]?.rows).map((p) => p.membershipId);
    for (let i = 0; i < todo.length; i += 6) {
      const r = await fetch("/api/dashboard/eval/rows", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId, membershipIds: todo.slice(i, i + 6) }),
      }).catch(() => null);
      const d = r ? await r.json().catch(() => null) : null;
      if (!r?.ok) {
        setError(ERR[d?.error] || "The comparison stopped. Try again.");
        break;
      }
      setJev((m) => ({ ...m, ...Object.fromEntries((d.results as JevPerson[]).map((x) => [x.membershipId, x])) }));
    }
    setBusy(false);
  }

  const stats = useMemo(() => {
    if (!data) return null;
    let rows = 0, agree = 0, asked = 0, same = 0, people = 0, ms = 0, tokens = 0, soft = 0, softRight = 0;
    const perRow = new Map<string, { label: string; n: number; agree: number }>();
    for (const p of data.people) {
      const j = jev[p.membershipId];
      if (!j?.rows) continue;
      people++;
      ms += j.ms || 0;
      tokens += j.inputTokens || 0;
      for (const jr of j.rows) {
        const g = p.rows.find((x) => x.id === jr.id);
        if (!g) continue;
        rows++;
        const ok = g.gpt === jr.status;
        if (ok) agree++;
        const pr = perRow.get(jr.id) || { label: g.label, n: 0, agree: 0 };
        pr.n++;
        if (ok) pr.agree++;
        perRow.set(jr.id, pr);
        if (jr.again) {
          asked++;
          if (jr.again.status === jr.status) same++;
        }
        if (jr.confidence < 0.5) {
          soft++;
          if (!ok) softRight++;
        }
      }
    }
    if (!people) return null;
    const usdPerPerson = ((tokens / people) * (data.usdPerMillionInput || 0.042)) / 1_000_000;
    return { people, rows, agree, asked, same, ms: Math.round(ms / people), tokens: Math.round(tokens / people), usdPerPerson, soft, softRight, perRow: [...perRow.values()] };
  }, [data, jev]);

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

  return (
    <>
      <h1 className="dash-h1">Row judge comparison</h1>
      <p className="dash-sub">
        Each scorecard row as GPT-4o judged it on the role&apos;s latest sourcing run, beside TypeSafe&apos;s Jev asked twice. Open the
        LinkedIn profile and decide who is right where they differ. Nothing here is stored or shown anywhere else.
      </p>

      <form className="jvc-bar" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <label>
          Job #
          <input value={jobId} onChange={(e) => setJobId(e.target.value.replace(/[^0-9a-z-]/gi, ""))} />
        </label>
        <button className="dash-btn dash-btn-2">Load</button>
        {data?.run && (
          <button type="button" className="dash-btn" onClick={run} disabled={busy || !data.keyPresent || !data.people.length}>
            {busy ? "Asking Jev…" : "Ask Jev about everyone"}
          </button>
        )}
      </form>
      {data && !data.keyPresent && <p className="dash-error">{ERR.no_key}</p>}
      {error && <p className="dash-error">{error}</p>}
      {data && !data.run && <p className="dash-muted">{data.role.title} has no finished sourcing run yet.</p>}
      {data?.run && !data.people.length && <p className="dash-muted">No one on that run has a scorecard verdict yet. Press Review again on the run first.</p>}

      {stats && (
        <div className="jvc-stats">
          <div><b>{pct(stats.agree, stats.rows)}</b>rows where Jev agrees with GPT-4o<small>{stats.agree} of {stats.rows} rows, {stats.people} people</small></div>
          <div><b>{pct(stats.same, stats.asked)}</b>Jev gives the same answer twice<small>{stats.same} of {stats.asked} rows</small></div>
          <div><b>{(stats.ms / 1000).toFixed(1)}s</b>per person, all rows<small>{stats.tokens.toLocaleString()} tokens in</small></div>
          <div><b>${(stats.usdPerPerson * 1000).toFixed(2)}</b>per 1,000 people<small>GPT-4o: about ${(GPT_USD_PER_PERSON * 1000).toFixed(0)}</small></div>
          <div><b>{stats.soft}</b>rows Jev is unsure of (&lt; 0.5)<small>{stats.softRight} of them are disagreements</small></div>
        </div>
      )}
      {stats && stats.perRow.length > 0 && (
        <p className="dash-muted jvc-perrow">
          Agreement by row: {stats.perRow.map((r) => `${r.label} ${pct(r.agree, r.n)}`).join(" · ")}
        </p>
      )}

      {data?.people.map((p) => {
        const j = jev[p.membershipId];
        return (
          <section className="jvc-person" key={p.membershipId}>
            <div className="jvc-who">
              <b>{p.name}</b>
              <span className="dash-muted">{p.title}</span>
              {p.linkedinUrl && <a href={p.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn ↗</a>}
              {j?.error && <span className="dash-error">{ERR[j.error] || j.error}{j.detail ? ` (${j.detail})` : ""}</span>}
            </div>
            <table className="jvc-table">
              <thead>
                <tr><th>Row</th><th>GPT-4o</th><th>Jev</th><th>Jev again</th><th>Jev&apos;s spread</th></tr>
              </thead>
              <tbody>
                {p.rows.map((r) => {
                  const jr = j?.rows?.find((x) => x.id === r.id);
                  const differs = jr && jr.status !== r.gpt;
                  return (
                    <tr key={r.id} className={differs ? "differs" : ""}>
                      <td>
                        <span className="jvc-tier">{r.tier}</span> {r.label}
                        {r.evidence && <small>{r.evidence}</small>}
                      </td>
                      <td><Mark s={r.gpt} /></td>
                      {r.byRule ? (
                        <td colSpan={3} className="dash-muted">decided by rule from the dated history, for both</td>
                      ) : jr ? (
                        <>
                          <td><Mark s={jr.status} /> <span className="jvc-conf">{jr.confidence.toFixed(2)}</span></td>
                          <td>{jr.again ? <Mark s={jr.again.status} dim={jr.again.status === jr.status} /> : "–"}</td>
                          <td className="jvc-spread">
                            {(["yes", "equivalent", "unknown", "no"] as RowStatus[]).map((s) => (
                              <span key={s} title={ROW_WORD[s]}>{ROW_MARK[s]} {Math.round((jr.probabilities[s] || 0) * 100)}</span>
                            ))}
                          </td>
                        </>
                      ) : (
                        <td colSpan={3} className="dash-muted">{busy ? "…" : "not asked yet"}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </>
  );
}
