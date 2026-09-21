"use client";
// Owner-only: each scorecard row as GPT-4o judged it, beside a second opinion
// from TypeSafe's Jev asked twice. Decides whether Jev should judge rows in
// the product; nothing here changes what the product shows. Each ask is
// saved (row_judge_evals) so it can be analysed.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import { ROUTE, ROW_MARK, ROW_WORD, labelClass, labelFromRows, routeStatus, type RowStatus, type Tier } from "@/lib/rolecard";
import { VERDICT_LABEL, type VerdictLabel } from "@/lib/verdict-view";

type StoredRow = { id: string; label: string; tier: Tier; gpt: RowStatus; likely?: boolean; evidence: string; byRule: boolean };
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
    let rows = 0, agree = 0, asked = 0, same = 0, people = 0, ms = 0, tokens = 0, soft = 0, softRight = 0, matters = 0;
    const perRow = new Map<string, { label: string; n: number; agree: number }>();
    const moved: { name: string; from: VerdictLabel; to: VerdictLabel }[] = [];
    for (const p of data.people) {
      const j = jev[p.membershipId];
      if (!j?.rows) continue;
      people++;
      ms += j.ms || 0;
      tokens += j.inputTokens || 0;
      // The label each judge's rows give, by the same fixed rules. Rows decided
      // by rule (career years) are the same for both.
      const gptLabel = labelFromRows(p.rows.map((r) => ({ tier: r.tier, status: r.gpt })), "message");
      const jevLabel = labelFromRows(
        p.rows.map((r) => {
          const jr = j.rows!.find((x) => x.id === r.id);
          return { tier: r.tier, status: jr ? routeStatus(jr.probabilities, jr.confidence) : r.gpt };
        }),
        "message"
      );
      if (gptLabel !== jevLabel) moved.push({ name: p.name, from: gptLabel, to: jevLabel });
      for (const jr of j.rows) {
        const g = p.rows.find((x) => x.id === jr.id);
        if (!g) continue;
        rows++;
        const ok = g.gpt === jr.status;
        if (ok) agree++;
        // What matters to the label: met / not shown / no, with Jev's spread
        // turned into a mark by the routing rule.
        const okMatters = labelClass(g.gpt) === labelClass(routeStatus(jr.probabilities, jr.confidence));
        if (okMatters) matters++;
        const pr = perRow.get(jr.id) || { label: g.label, n: 0, agree: 0 };
        pr.n++;
        if (okMatters) pr.agree++;
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
    return { people, rows, agree, matters, moved, asked, same, ms: Math.round(ms / people), tokens: Math.round(tokens / people), usdPerPerson, soft, softRight, perRow: [...perRow.values()] };
  }, [data, jev]);

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

  return (
    <>
      <h1 className="dash-h1">Row judge comparison</h1>
      <p className="dash-sub">
        Each scorecard row as GPT-4o judged it on the role&apos;s latest sourcing run, beside TypeSafe&apos;s Jev asked twice. Open the
        LinkedIn profile and decide who is right where they differ. Each ask is saved for analysis; nothing here is shown anywhere else.
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
          <div><b>{pct(stats.matters, stats.rows)}</b>agreement that matters to the label<small>{stats.matters} of {stats.rows} rows: met / not shown / no, Jev routed</small></div>
          <div><b>{stats.moved.length} of {stats.people}</b>people whose label would change<small>if Jev judged the rows</small></div>
          <div><b>{pct(stats.agree, stats.rows)}</b>identical marks, raw<small>{stats.agree} of {stats.rows} rows; counts ✓ vs ≈ as a miss</small></div>
          <div><b>{pct(stats.same, stats.asked)}</b>Jev gives the same answer twice<small>{stats.same} of {stats.asked} rows</small></div>
          <div><b>{(stats.ms / 1000).toFixed(1)}s</b>per person, all rows<small>{stats.tokens.toLocaleString()} tokens in</small></div>
          <div><b>${(stats.usdPerPerson * 1000).toFixed(2)}</b>per 1,000 people<small>GPT-4o: about ${(GPT_USD_PER_PERSON * 1000).toFixed(0)}</small></div>
          <div><b>{stats.soft}</b>rows Jev is unsure of (&lt; 0.5)<small>{stats.softRight} of them are disagreements</small></div>
        </div>
      )}
      {stats && (
        <p className="dash-muted jvc-perrow">
          Routing rule for Jev: &ldquo;met&rdquo; needs {Math.round(ROUTE.metAtLeast * 100)}% or more across ✓ and ≈, a met class that beats &ldquo;not shown&rdquo; on its own, and
          confidence of {ROUTE.confidenceAtLeast} or more. A &ldquo;no&rdquo; is never taken from Jev: Pass is decided by the years rule or by you. ✓ and ≈ count the same for the label.
        </p>
      )}
      {stats && stats.moved.length > 0 && (
        <p className="jvc-perrow">
          <b>Labels that would change:</b>{" "}
          {stats.moved.map((m) => `${m.name}: ${VERDICT_LABEL[m.from]} → ${VERDICT_LABEL[m.to]}`).join(" · ")}
        </p>
      )}
      {stats && stats.perRow.length > 0 && (
        <p className="dash-muted jvc-perrow">
          Agreement that matters, by row: {stats.perRow.map((r) => `${r.label} ${pct(r.agree, r.n)}`).join(" · ")}
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
                <tr><th>Row</th><th>GPT-4o</th><th>Jev, routed</th><th>Jev, raw</th><th>Jev again</th><th>Jev&apos;s spread</th></tr>
              </thead>
              <tbody>
                {p.rows.map((r) => {
                  const jr = j?.rows?.find((x) => x.id === r.id);
                  const routed = jr ? routeStatus(jr.probabilities, jr.confidence) : null;
                  // Highlighted only when the difference would matter to the label.
                  const differs = routed && labelClass(routed) !== labelClass(r.gpt);
                  return (
                    <tr key={r.id} className={differs ? "differs" : ""}>
                      <td>
                        <span className="jvc-tier">{r.tier}</span> {r.label}
                        {r.evidence && <small>{r.evidence}</small>}
                      </td>
                      <td>
                        <Mark s={r.gpt} />

                      </td>
                      {r.byRule ? (
                        <td colSpan={4} className="dash-muted">decided by rule from the dated history, for both</td>
                      ) : jr ? (
                        <>
                          <td><Mark s={routed!} /></td>
                          <td><Mark s={jr.status} dim /> <span className="jvc-conf">{jr.confidence.toFixed(2)}</span></td>
                          <td>{jr.again ? <Mark s={jr.again.status} dim={jr.again.status === jr.status} /> : "–"}</td>
                          <td className="jvc-spread">
                            {(["yes", "equivalent", "unknown", "no"] as RowStatus[]).map((s) => (
                              <span key={s} title={ROW_WORD[s]}>{ROW_MARK[s]} {Math.round((jr.probabilities[s] || 0) * 100)}</span>
                            ))}
                          </td>
                        </>
                      ) : (
                        <td colSpan={4} className="dash-muted">{busy ? "…" : "not asked yet"}</td>
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
