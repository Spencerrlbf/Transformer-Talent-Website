"use client";
// The review as bullets: why they fit the role, then what is missing or to
// confirm on a call. Each bullet carries the mark of the strongest row it
// rests on and, at its end, one evidence tag per cited row that has
// something to show. The evidence is never in the sentence: a tag opens a
// popover (on hover, focus or a click) with the verified lines and where
// they were found, and a link to the row on the checklist.
import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { NO_LINE_SOURCE, ROW_WORD, reviewMark, type CardRow, type Review, type ReviewBullet, type RowStatus } from "@/lib/rolecard";
import { sentences } from "@/lib/verdict-view";
import { openChecklistRow, rowAnchor } from "@/components/dashboard/rolecard/Checklist";

/** The one-line verdict at the top of the card, and the one thing to confirm. */
export function BottomLine({ text }: { text: string }) {
  return <p className="vc-bottomline">{text}</p>;
}

const isMet = (s: RowStatus) => s === "yes" || s === "equivalent";
const STRENGTH: Record<RowStatus, number> = { yes: 4, equivalent: 3, short: 2, unknown: 1, no: 0 };
const strongest = (rows: CardRow[]): RowStatus => rows.reduce<RowStatus>((best, r) => (STRENGTH[r.status] > STRENGTH[best] ? r.status : best), rows[0]?.status ?? "unknown");

interface Line {
  text: string;
  source: string;
  /** Copied from the profile or resume, shown in quotation marks; else a line code wrote. */
  quoted: boolean;
}

/** What a cited row can show behind a bullet: its tag, and the lines the popover lists. */
interface Evidence {
  row: CardRow;
  label: string;
  lines: Line[];
  /** A met judgment row with no single line to quote: the whole material read that way. */
  whole: boolean;
}

/** "Work history · Founding Engineer at Perch" reads "Work history · Perch"
 *  on a tag; the popover keeps the whole line. */
const shortSource = (s: string) => {
  const m = s.match(/^(.+?) · .+? at (.+)$/);
  return m ? `${m[1]} · ${m[2]}` : s;
};

const linesOf = (r: CardRow): Line[] => {
  if (r.quotes?.length) return r.quotes.map((q) => ({ text: q.text, source: q.source, quoted: true }));
  if (r.quote) return [{ text: r.quote, source: r.source || "Profile", quoted: true }];
  return [];
};

function evidenceOf(r: CardRow): Evidence | null {
  const lines = linesOf(r);
  if (lines.length) {
    const src = shortSource(lines[0].source);
    return { row: r, label: lines.length > 1 ? `${src} · ${lines.length} lines` : src, lines, whole: false };
  }
  // "No single line" is said of a met row only, as on the checklist.
  if (r.source === NO_LINE_SOURCE) return isMet(r.status) ? { row: r, label: "Whole profile", lines: [], whole: true } : null;
  // A row code decided (years, a technology not found) has a source and its own line, no quote.
  if (r.source && r.evidence) return { row: r, label: shortSource(r.source), lines: [{ text: r.evidence, source: r.source, quoted: false }], whole: false };
  return null;
}

const CLOSE_AFTER_MS = 150;

function EvidenceTag({ e }: { e: Evidence }) {
  const popId = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  // A press that began inside the popover: the button's blur is not a leave.
  const downInside = useRef(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [flip, setFlip] = useState(false);

  const clearTimer = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const show = () => {
    clearTimer();
    setOpen(true);
  };
  const close = () => {
    clearTimer();
    setOpen(false);
    setPinned(false);
  };
  // Leaving with the mouse closes it after a beat, so the pointer can cross
  // the gap into the popover. A click pins it until Escape or a click outside.
  const hideSoon = () => {
    if (pinned) return;
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_AFTER_MS);
  };
  const mouseOnly = (fn: () => void) => (ev: PointerEvent) => {
    if (ev.pointerType === "mouse") fn();
  };

  useEffect(() => clearTimer, []);

  // A press outside closes it; a press inside is remembered for the blur.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: Event) => {
      const inside = !!wrap.current?.contains(ev.target as Node);
      downInside.current = inside;
      if (!inside) close();
    };
    const onUp = () => {
      downInside.current = false;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
    };
  }, [open]);

  // Escape closes it wherever the focus is (a hover needs none), and never
  // reaches the drawer around it, which closes on Escape too: caught at the
  // document in the capture phase, before the drawer's own listener.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      const hadFocus = !!wrap.current?.contains(document.activeElement);
      close();
      if (hadFocus) btn.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Keep it on screen: when it would run past the card's right edge, hang it
  // from the tag's right side instead.
  useLayoutEffect(() => {
    if (!open || !pop.current || !btn.current) return;
    const width = pop.current.getBoundingClientRect().width;
    const tag = btn.current.getBoundingClientRect();
    const box = wrap.current?.closest(".vc")?.getBoundingClientRect();
    const rightEdge = Math.min(window.innerWidth, box?.right ?? window.innerWidth) - 8;
    const leftEdge = Math.max(0, box?.left ?? 0) + 8;
    const fitsLeft = tag.left + width <= rightEdge;
    const fitsRight = tag.right - width >= leftEdge;
    setFlip(!fitsLeft && (fitsRight || tag.left > (leftEdge + rightEdge) / 2));
  }, [open]);

  const onBlur = (ev: FocusEvent<HTMLSpanElement>) => {
    if (downInside.current) return;
    if (!wrap.current?.contains(ev.relatedTarget as Node | null)) close();
  };

  return (
    <span className="vc-evwrap" ref={wrap} onBlur={onBlur}>
      <button
        type="button"
        ref={btn}
        className={`vc-evtag${open ? " open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={e.whole ? "No single line says it: the whole profile and resume read this way" : "The lines behind this, and where they were found"}
        onPointerEnter={mouseOnly(show)}
        onPointerLeave={mouseOnly(hideSoon)}
        onFocus={show}
        onClick={() => {
          if (open && pinned) close();
          else {
            setPinned(true);
            show();
          }
        }}
      >
        {e.label}
      </button>
      {open && (
        <div
          ref={pop}
          id={popId}
          role="dialog"
          aria-label={`Evidence for ${e.row.label}: ${e.label}`}
          className={`vc-pop${flip ? " flip" : ""}`}
          onPointerEnter={mouseOnly(show)}
          onPointerLeave={mouseOnly(hideSoon)}
        >
          <div className="vc-pop-h">
            <span>{e.label}</span>
            <a
              className="vc-pop-open"
              href={`#${rowAnchor(e.row.id)}`}
              onClick={(ev) => {
                ev.preventDefault();
                close();
                openChecklistRow(e.row.id, wrap.current);
              }}
            >
              open the row
            </a>
          </div>
          {e.whole ? (
            <p className="vc-pop-q">The whole profile and resume read this way; no one line says it in as many words.</p>
          ) : (
            e.lines.map((l, i) => (
              <div className="vc-pop-line" key={i}>
                <p className="vc-pop-q">{l.quoted ? <>&ldquo;{l.text}&rdquo;</> : l.text}</p>
                <small className="vc-pop-s">{l.source}</small>
              </div>
            ))
          )}
          <small className="vc-pop-row">On the row: {e.row.label}</small>
        </div>
      )}
    </span>
  );
}

function Bullet({ b, byId }: { b: ReviewBullet; byId: Map<string, CardRow> }) {
  const cited = b.rowIds.map((id) => byId.get(id)).filter((r): r is CardRow => !!r);
  const status: RowStatus = cited.length ? strongest(cited) : "unknown";
  const text = b.text.trim();
  // The first sentence leads in bold when there is more than one.
  const parts = sentences(text);
  const lead = parts.length > 1 && text.startsWith(parts[0]) ? parts[0] : "";
  const rest = lead ? text.slice(lead.length).trim() : text;
  const tags = cited.map(evidenceOf).filter((e): e is Evidence => !!e);
  return (
    <li className="vc-bullet">
      <span className={`vc-bmark m-${status}`} role="img" aria-label={ROW_WORD[status]} title={ROW_WORD[status]}>
        {reviewMark(status)}
      </span>
      <div className="vc-btext">
        {lead && <b>{lead}</b>}
        {lead && rest && " "}
        {rest}
        {tags.length > 0 && " "}
        {tags.map((e) => (
          <EvidenceTag key={e.row.id} e={e} />
        ))}
      </div>
    </li>
  );
}

export default function ReviewBullets({ review, rows }: { review: Review; rows: CardRow[] }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (!review.fits.length && !review.gaps.length) return null;
  return (
    <>
      {review.fits.length > 0 && (
        <section className="vc-rsec">
          <h4 className="vc-sec">Why they fit the role</h4>
          <ul className="vc-bullets">
            {review.fits.map((b, i) => (
              <Bullet key={`f-${i}`} b={b} byId={byId} />
            ))}
          </ul>
        </section>
      )}
      {review.gaps.length > 0 && (
        <section className="vc-rsec">
          <h4 className="vc-sec">Missing, or to confirm on a call</h4>
          <ul className="vc-bullets">
            {review.gaps.map((b, i) => (
              <Bullet key={`g-${i}`} b={b} byId={byId} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
