"use client";
// The role's scorecard as judged for one person: every row with the judge's
// answer and its evidence. With `feedback`, each row is a one-click check-off:
// press ✓ ≈ ? or × to say what you know (from the profile, a call, an
// interview). The label follows at once, it sticks through Review again, and
// it is kept as a confirmed fact about the person for other roles.
//
// Clicks never lock the list. Each one shows at once and is sent in turn; the
// server's answer replaces the view only when nothing newer is waiting, and a
// failed save puts back the last state the server confirmed.
import { useEffect, useId, useRef, useState } from "react";
import { useDash } from "../DashShell";
import {
  NO_LINE_SOURCE,
  ROW_MARK,
  ROW_STATUSES,
  ROW_WORD,
  TIERS,
  TIER_LABEL,
  applyOverrides,
  certaintyAt,
  labelFromRows,
  tally,
  isCareerYearsRow,
  type CardRow,
  type RowOverride,
  type RowStatus,
} from "@/lib/rolecard";
import type { VerdictView } from "@/lib/verdict-view";
import { TierIcon } from "./ScorecardEditor";

export interface VerdictFeedbackTarget {
  /** Who the verdict is stored under: "app_<id>" | "src_<id>". */
  candidateKey: string;
  jobId: string;
  /** The sourcing-run row on screen, when there is one. */
  membershipId?: string;
  /** The verdict as it should now read (at once, then as the server stored it). */
  onChanged: (view: VerdictView) => void;
  /** Everything sent has been stored. */
  onSaved?: () => void;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

const nameFromEmail = (email: string) => {
  const first = email.split("@")[0].split(/[._+-]/)[0] || email;
  return first.charAt(0).toUpperCase() + first.slice(1);
};

const overridesOf = (rows: CardRow[]): RowOverride[] =>
  rows.filter((r) => r.confirmed).map((r) => ({ criterionId: r.id, status: r.status, note: r.confirmed!.note, by: r.confirmed!.by, at: r.confirmed!.at }));

/** The anchor of a row on the judged checklist; the review's evidence tags
 *  link to it. `scope` is the card's own id, so two cards on one page (a run
 *  table can show two with the same rows) never share an anchor. */
export const rowAnchor = (id: string, scope = "") => `ck-row-${id}${scope ? `-${scope}` : ""}`;

/** A card's anchor scope from React's useId: letters, digits, dashes and
 *  underscores only, so it sits in an id and in a hash link as it is. */
export const anchorScopeOf = (uid: string) => uid.replace(/[^A-Za-z0-9_-]/g, "");

const LIT_FOR_MS = 2000;

/** Scroll the checklist to a row and light it for two seconds. Looks inside
 *  the card `from` sits in first (a run table can show two cards with the
 *  same rows), then anywhere on the page. Rows are found by the criterion
 *  id they carry, whatever card scope their anchor has. */
export function openChecklistRow(id: string, from?: Element | null) {
  if (typeof document === "undefined") return;
  const scope: ParentNode = from?.closest(".vc") ?? document;
  const sel = `[data-ck-row="${id.replace(/["\\]/g, "\\$&")}"]`;
  const el = (scope.querySelector(sel) ?? document.querySelector(sel)) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus({ preventScroll: true });
  el.classList.add("ck-hl");
  window.setTimeout(() => el.classList.remove("ck-hl"), LIT_FOR_MS);
}

/** Who decided the row and how far up its ladder it got. Code decides years
 *  and technology rows; a judgment row carries the judge's rung and how sure
 *  it was of it. Older saved reviews carry none of this and show nothing. */
function receipt(r: CardRow): string | null {
  if (!r.judgedBy) return null;
  const rung = r.level != null && r.levels != null ? `rung ${r.level} of ${r.levels}` : "";
  if (r.judgedBy === "code") return rung ? `by code · ${rung}` : "by code";
  const sure = r.p?.length && r.level != null ? ` · ${Math.round(certaintyAt(r.p, r.level) * 100)}%` : "";
  return `Jev${rung ? ` · ${rung}` : ""}${sure}`;
}

/** The line under a row: where the words were found, with the words; or, on
 *  a met judgment row with nothing to quote, that the whole material read
 *  that way. "No single line" is said of a met row only: once the row counts
 *  from a higher rung it is not met, and the line goes with the tick. A pass
 *  on which no line was looked for (the reference call failed) shows nothing. */
const sourceLine = (r: CardRow): string | null => {
  if (r.quote) return r.source || "Profile";
  if (!r.source) return null;
  return r.source === NO_LINE_SOURCE && r.status !== "yes" && r.status !== "equivalent" ? null : r.source;
};

/** A years row within a year of its bar: the numbers, in place of a mark. */
function ShortPill({ r }: { r: CardRow }) {
  if (r.status !== "short") return null;
  return (
    <span className="ck-mark s-short" title={`Short: ${r.evidence || "within a year of the bar"}`}>
      {r.numbers ? `${r.numbers.have} / ${r.numbers.bar}+` : ROW_MARK.short}
    </span>
  );
}

const FAIL: Record<string, string> = {
  no_card: "This verdict was written before the role had a scorecard. Review the person again, then check rows off.",
  row_not_found: "That row is no longer on this verdict. Review the person again to get the current scorecard.",
  role_not_found: "That role could not be found.",
};

export default function Checklist({ view, feedback, anchorScope }: { view: VerdictView; feedback?: VerdictFeedbackTarget; anchorScope?: string }) {
  const { token, name, email } = useDash();
  const me = name || nameFromEmail(email);
  // The card's own scope for its row anchors, so two cards never share an id.
  const ownScope = anchorScopeOf(useId());
  const scope = anchorScope ?? ownScope;
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState("");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  // Requests go one at a time, in click order.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const good = useRef(view); // the last view the server confirmed
  const latest = useRef(view); // what is on screen, optimistic clicks included
  const live = useRef(true);
  const fb = useRef(feedback);
  fb.current = feedback;
  latest.current = view;
  if (pending.current === 0) good.current = view;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const card = view.card;
  if (!card?.rows.length) return null;

  function send(body: Record<string, unknown>, optimistic: VerdictView) {
    const target = fb.current;
    if (!target) return;
    setError("");
    target.onChanged(optimistic);
    latest.current = optimistic;
    pending.current++;
    setWaiting(pending.current);
    chain.current = chain.current.then(async () => {
      const r = await fetch("/api/dashboard/rolecard/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidateKey: target.candidateKey, jobId: target.jobId, membershipId: target.membershipId, ...body }),
      }).catch(() => null);
      const d = r ? await r.json().catch(() => null) : null;
      pending.current--;
      const ok = !!r?.ok && !!d?.verdict;
      if (ok) good.current = d.verdict;
      if (!live.current) return;
      setWaiting(pending.current);
      if (!ok) setError(FAIL[d?.error] || "That did not save. Try again.");
      // Only the last answer lands: an earlier one would wipe a newer click.
      if (pending.current === 0) {
        target.onChanged(good.current);
        if (ok) target.onSaved?.();
      }
    });
  }

  function rule(row: CardRow, status: RowStatus | null, withNote?: string) {
    const now = latest.current;
    const rows = now.card?.rows || [];
    const current = rows.find((r) => r.id === row.id) || row;
    const keepNote = withNote ?? current.confirmed?.note ?? null;
    const others = overridesOf(rows).filter((o) => o.criterionId !== row.id);
    const mine: RowOverride[] = status ? [{ criterionId: row.id, status, note: keepNote, by: me, at: new Date().toISOString() }] : [];
    send({ criterionId: row.id, status, note: keepNote }, applyOverrides(now, [...others, ...mine], now.card?.wrongRole ?? null));
  }

  // The label is held below what the rows alone give (the years rail).
  const held = card.railNote && view.label !== labelFromRows(card.rows, view.label) ? card.railNote : null;

  return (
    <div className="ck" aria-busy={waiting > 0}>
      <div className="ck-head">
        <span className="vc-lbl">Scorecard</span>
        <span className="ck-tally">
          {waiting > 0 && <span className="ck-saving">Saving…</span>}
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
      {held && (
        <p className="ck-held">
          Held at Worth a message: {held}{" "}
          {card.rows.some((r) => isCareerYearsRow(r.label))
            ? "Confirm the years row to lift it."
            : "Add a years row to the scorecard if you want to confirm it."}
        </p>
      )}
      {(card.holds || []).map((h) => (
        <p className="ck-held" key={`${h.kind}-${h.note}`}>
          {h.label === "pass" ? "Pass on this role" : "Held at Worth a message"}: {h.note}
        </p>
      ))}
      {TIERS.map((tier) => {
        const rows = card.rows.filter((r) => r.tier === tier);
        if (!rows.length) return null;
        return (
          <div className={`ck-tier rc-${tier}`} key={tier}>
            {rows.map((r) => (
              <div className={`ck-row s-${r.status}${r.confirmed ? " confirmed" : ""}`} key={r.id} id={rowAnchor(r.id, scope)} data-ck-row={r.id} tabIndex={-1}>
                <span className="ck-ico" title={TIER_LABEL[tier]}>
                  <TierIcon tier={tier} />
                </span>
                <div className="ck-body">
                  <div className="ck-label">
                    {r.label}
                    {r.call && r.status === "unknown" && (
                      <span className="ck-call" title="Profiles rarely say this, so this role confirms it on a call. While it is not shown it does not hold the label back.">
                        confirm on a call
                      </span>
                    )}
                  </div>
                  {r.confirmed ? (
                    <div className="ck-ev">
                      Confirmed by {r.confirmed.by}
                      {day(r.confirmed.at) && `, ${day(r.confirmed.at)}`}
                      {r.confirmed.note && `: ${r.confirmed.note}`}
                      {r.ai !== r.status && <span className="ck-was"> · the AI read {ROW_WORD[r.ai].toLowerCase()}</span>}
                      {feedback && (
                        <>
                          {" · "}
                          <button type="button" className="ck-link" onClick={() => { setNoteFor(noteFor === r.id ? null : r.id); setNote(r.confirmed?.note || ""); }}>
                            {r.confirmed.note ? "Edit note" : "Add a note"}
                          </button>
                          {" · "}
                          <button type="button" className="ck-link" onClick={() => rule(r, null)}>
                            Undo
                          </button>
                        </>
                      )}
                    </div>
                  ) : (
                    (r.evidence || r.quote || receipt(r)) && (
                      <div className="ck-ev">
                        {receipt(r) && <span className="ck-receipt">{receipt(r)}</span>}
                        {r.evidence}
                        {/* Where it was found, and the words found there. Older saved
                            reviews carry a quote but no source: those say "Profile". */}
                        {sourceLine(r) && (
                          <span
                            className="ck-src"
                            title={
                              sourceLine(r) === NO_LINE_SOURCE
                                ? "The whole profile and resume read this way; no one line says it in as many words."
                                : "Where this was found. The words in quotes are copied from there."
                            }
                          >
                            {sourceLine(r)}
                            {r.quote && <span className="ck-quote">: &ldquo;{r.quote}&rdquo;</span>}
                          </span>
                        )}
                      </div>
                    )
                  )}
                  {noteFor === r.id && feedback && r.confirmed && (
                    <form
                      className="ck-note"
                      onSubmit={(e) => {
                        e.preventDefault();
                        setNoteFor(null);
                        rule(r, r.status, note.trim());
                      }}
                    >
                      <input
                        value={note}
                        maxLength={240}
                        autoFocus
                        aria-label="How you know"
                        placeholder="How you know, e.g. built the Playwright harness at Acme (call, 21 Sept)"
                        onChange={(e) => setNote(e.target.value)}
                        onKeyDown={(e) => {
                          // Esc closes the note, not the drawer around it.
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            e.nativeEvent.stopImmediatePropagation();
                            setNoteFor(null);
                          }
                        }}
                      />
                      <button className="dash-btn dash-btn-2">Save note</button>
                    </form>
                  )}
                </div>
                {feedback ? (
                  <span className="ck-act">
                  <ShortPill r={r} />
                  <span className="ck-seg" role="group" aria-label={`Your call on: ${r.label}`}>
                    {ROW_STATUSES.map((s) => {
                      const on = r.status === s;
                      const done = on && !!r.confirmed;
                      return (
                        <button
                          type="button"
                          key={s}
                          className={`ck-b b-${s}${on ? " on" : ""}${done ? " done" : ""}`}
                          aria-label={`${ROW_WORD[s]}${done ? ", confirmed" : on ? ", the AI's read" : ""}`}
                          aria-pressed={on}
                          title={done ? `${ROW_WORD[s]}, confirmed. Use Undo to take it back.` : on ? `${ROW_WORD[s]}: the AI's read. Press to confirm it.` : `Mark as: ${ROW_WORD[s]}`}
                          onClick={() => (done ? undefined : rule(r, s))}
                        >
                          {ROW_MARK[s]}
                        </button>
                      );
                    })}
                  </span>
                  </span>
                ) : r.status === "short" ? (
                  <ShortPill r={r} />
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
          {card.rows.some((r) => r.status === "short") && <> <b className="s-short">△</b> short: within a year of the bar</>}
          {feedback && <em> · press one to say what you know. It sticks, and it is remembered about this person.</em>}
        </span>
        {feedback && (
          <button
            type="button"
            className={`ck-wrong${card.wrongRole ? " on" : ""}`}
            aria-pressed={!!card.wrongRole}
            title={card.wrongRole ? `Marked by ${card.wrongRole.by}. Press to take it back.` : "A good person, for a different role. Saved with this verdict."}
            onClick={() => {
              const now = latest.current;
              const on = !now.card?.wrongRole;
              send({ wrongRole: on }, applyOverrides(now, overridesOf(now.card?.rows || []), on ? { by: me, at: new Date().toISOString() } : null));
            }}
          >
            {card.wrongRole ? "✓ Right person, wrong role" : "Right person, wrong role"}
          </button>
        )}
      </div>
    </div>
  );
}
