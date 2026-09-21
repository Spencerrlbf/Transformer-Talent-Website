"use client";
// The role's scorecard as judged for one person: every row with the judge's
// answer and its evidence. With `feedback`, each row is a one-click check-off:
// press ✓ ≈ ? or × to say what you know (from the profile, a call, an
// interview). The label follows at once, it sticks through Review again, and
// it is kept on the person for every future role.
import { useState } from "react";
import { useDash } from "../DashShell";
import {
  ROW_MARK,
  ROW_STATUSES,
  ROW_WORD,
  TIERS,
  TIER_LABEL,
  applyOverrides,
  tally,
  type CardRow,
  type RowOverride,
  type RowStatus,
} from "@/lib/rolecard";
import type { VerdictView } from "@/lib/verdict-view";
import { TierIcon } from "./ScorecardEditor";

export interface VerdictFeedbackTarget {
  candidateKey: string;
  jobId: string;
  /** The verdict as it now reads, after the server stored the change. */
  onChanged: (view: VerdictView) => void;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

const overridesOf = (rows: CardRow[]): RowOverride[] =>
  rows.filter((r) => r.confirmed).map((r) => ({ criterionId: r.id, status: r.status, note: r.confirmed!.note, by: r.confirmed!.by, at: r.confirmed!.at }));

export default function Checklist({ view, feedback }: { view: VerdictView; feedback?: VerdictFeedbackTarget }) {
  const { token } = useDash();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const card = view.card;
  if (!card?.rows.length) return null;

  async function send(body: Record<string, unknown>, optimistic: VerdictView | null, key: string) {
    if (!feedback) return;
    setError("");
    setBusy(key);
    if (optimistic) feedback.onChanged(optimistic);
    const r = await fetch("/api/dashboard/rolecard/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ candidateKey: feedback.candidateKey, jobId: feedback.jobId, ...body }),
    }).catch(() => null);
    const d = r ? await r.json().catch(() => null) : null;
    setBusy(null);
    if (!r?.ok || !d?.verdict) {
      feedback.onChanged(view); // put back what was there
      return setError("That did not save. Try again.");
    }
    feedback.onChanged(d.verdict);
  }

  function rule(row: CardRow, status: RowStatus | null, withNote?: string) {
    const others = overridesOf(card!.rows).filter((o) => o.criterionId !== row.id);
    const mine: RowOverride[] = status ? [{ criterionId: row.id, status, note: withNote ?? row.confirmed?.note ?? null, by: "you", at: new Date().toISOString() }] : [];
    const optimistic = applyOverrides(view, [...others, ...mine], card!.wrongRole ?? null);
    return send({ criterionId: row.id, status, note: withNote ?? row.confirmed?.note ?? null }, optimistic, row.id);
  }

  return (
    <div className="ck">
      <div className="ck-head">
        <span className="vc-lbl">Scorecard</span>
        <span className="ck-tally">
          {TIERS.map((t) => {
            const n = tally(card.rows, t);
            return n.of ? (
              <span key={t} className={`ck-t rc-${t}`} title={`${TIER_LABEL[t]}: ${n.met} of ${n.of} met`}>
                <TierIcon tier={t} />
                {n.met}/{n.of}
              </span>
            ) : null;
          })}
        </span>
      </div>
      {TIERS.map((tier) => {
        const rows = card.rows.filter((r) => r.tier === tier);
        if (!rows.length) return null;
        return (
          <div className={`ck-tier rc-${tier}`} key={tier}>
            {rows.map((r) => (
              <div className={`ck-row s-${r.status}${r.confirmed ? " confirmed" : ""}`} key={r.id}>
                <span className="ck-ico" title={TIER_LABEL[tier]}>
                  <TierIcon tier={tier} />
                </span>
                <div className="ck-body">
                  <div className="ck-label">{r.label}</div>
                  {r.confirmed ? (
                    <div className="ck-ev">
                      Confirmed by {r.confirmed.by}
                      {day(r.confirmed.at) && `, ${day(r.confirmed.at)}`}
                      {r.confirmed.note && `: ${r.confirmed.note}`}
                      {r.ai !== r.status && <span className="ck-was"> · the AI read {ROW_WORD[r.ai].toLowerCase()}</span>}
                      {feedback && (
                        <>
                          {" · "}
                          <button type="button" className="ck-link" disabled={busy !== null} onClick={() => { setNoteFor(noteFor === r.id ? null : r.id); setNote(r.confirmed?.note || ""); }}>
                            {r.confirmed.note ? "Edit note" : "Add a note"}
                          </button>
                          {" · "}
                          <button type="button" className="ck-link" disabled={busy !== null} onClick={() => rule(r, null)}>
                            Undo
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    r.evidence && <div className="ck-ev">{r.evidence}</div>
                  )}
                  {noteFor === r.id && feedback && (
                    <form
                      className="ck-note"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setNoteFor(null);
                        rule(r, r.status, note.trim());
                      }}
                    >
                      <input value={note} maxLength={240} autoFocus placeholder="How you know, e.g. built the Playwright harness at Acme (call, 21 Sept)" onChange={(e) => setNote(e.target.value)} />
                      <button className="dash-btn dash-btn-2" disabled={busy !== null}>Save note</button>
                    </form>
                  )}
                </div>
                {feedback ? (
                  <span className="ck-seg" role="group" aria-label={`Your call on: ${r.label}`}>
                    {ROW_STATUSES.map((s) => (
                      <button
                        type="button"
                        key={s}
                        className={`ck-b b-${s}${r.status === s ? " on" : ""}`}
                        disabled={busy !== null}
                        title={r.status === s && r.confirmed ? `${ROW_WORD[s]} (confirmed)` : r.status === s ? `${ROW_WORD[s]}: the AI's read. Press to confirm it.` : `Mark as: ${ROW_WORD[s]}`}
                        aria-pressed={r.status === s}
                        onClick={() => (r.status === s && r.confirmed ? undefined : rule(r, s))}
                      >
                        {ROW_MARK[s]}
                      </button>
                    ))}
                  </span>
                ) : (
                  <span className={`ck-mark b-${r.status}`} title={ROW_WORD[r.status]}>
                    {ROW_MARK[r.status]}
                  </span>
                )}
              </div>
            ))}
          </div>
        );
      })}
      {error && <p className="dash-error">{error}</p>}
      <div className="ck-foot">
        <span className="ck-key">
          <b className="b-yes">✓</b> yes <b className="b-equivalent">≈</b> equivalent <b className="b-unknown">?</b> not shown <b className="b-no">×</b> no
          {feedback && <em> · press one to say what you know; it sticks, and it is remembered for this person</em>}
        </span>
        {feedback && (
          <button
            type="button"
            className={`ck-wrong${card.wrongRole ? " on" : ""}`}
            disabled={busy !== null}
            title={card.wrongRole ? `Marked by ${card.wrongRole.by}. Press to take it back.` : "A good person for a different role. Kept on the person so they surface when that role comes up."}
            onClick={() =>
              send(
                { wrongRole: !card.wrongRole },
                applyOverrides(view, overridesOf(card.rows), card.wrongRole ? null : { by: "you", at: new Date().toISOString() }),
                "_wrong"
              )
            }
          >
            {card.wrongRole ? "✓ Right person, wrong role" : "Right person, wrong role"}
          </button>
        )}
      </div>
    </div>
  );
}
