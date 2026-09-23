"use client";
// The review as bullets: why they fit the role, then what is missing or to
// confirm on a call. A fit bullet carries the mark of the strongest row it
// rests on, a gap bullet the weakest, and at its end one evidence tag per
// cited row: the verified lines behind it, the recruiter's own confirmation,
// or, when nothing was found, the row's chip so the row stays reachable. The
// evidence is never in the sentence: a tag opens a popover (on hover, focus
// or a click) with the lines and where they were found, and a link to the
// row on the checklist.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent } from "react";
import { NO_LINE_SOURCE, ROW_WORD, chipLabel, reviewMark, type CardRow, type Review, type ReviewBullet, type RowStatus } from "@/lib/rolecard";
import { sentences } from "@/lib/verdict-view";
import { openChecklistRow, rowAnchor } from "@/components/dashboard/rolecard/Checklist";

/** The one-line verdict at the top of the card, and the one thing to confirm. */
export function BottomLine({ text }: { text: string }) {
  return <p className="vc-bottomline">{text}</p>;
}

const isMet = (s: RowStatus) => s === "yes" || s === "equivalent";
const STRENGTH: Record<RowStatus, number> = { yes: 4, equivalent: 3, short: 2, unknown: 1, no: 0 };
const strongest = (rows: CardRow[]): RowStatus => rows.reduce<RowStatus>((best, r) => (STRENGTH[r.status] > STRENGTH[best] ? r.status : best), rows[0]?.status ?? "unknown");
const weakest = (rows: CardRow[]): RowStatus => rows.reduce<RowStatus>((worst, r) => (STRENGTH[r.status] < STRENGTH[worst] ? r.status : worst), rows[0]?.status ?? "unknown");

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

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

function evidenceOf(r: CardRow): Evidence | null {
  // A row the recruiter confirmed: their word is the evidence, as on the
  // checklist, and the tag says so.
  if (r.confirmed) {
    const who = `Confirmed by ${r.confirmed.by}`;
    const when = day(r.confirmed.at);
    return { row: r, label: who, lines: [{ text: r.confirmed.note || "No note was left.", source: when ? `${who}, ${when}` : who, quoted: false }], whole: false };
  }
  const lines = linesOf(r);
  if (lines.length) {
    // One source names it on the tag; lines from different places say only how many there are.
    const sources = new Set(lines.map((l) => shortSource(l.source)));
    const src = sources.size === 1 ? shortSource(lines[0].source) : "";
    const label = lines.length > 1 ? (src ? `${src} · ${lines.length} lines` : `${lines.length} lines`) : src;
    return { row: r, label, lines, whole: false };
  }
  // "No single line" is said of a met row only, as on the checklist.
  if (r.source === NO_LINE_SOURCE) return isMet(r.status) ? { row: r, label: "Whole profile", lines: [], whole: true } : null;
  // A row code decided (years, a technology not found) has a source and its own line, no quote.
  if (r.source && r.evidence) return { row: r, label: shortSource(r.source), lines: [{ text: r.evidence, source: r.source, quoted: false }], whole: false };
  // A met row with nothing to show (no line was looked for): the tag carries
  // the row's chip, so the row is still one click away.
  if (isMet(r.status)) return { row: r, label: r.short || chipLabel(r.label), lines: r.evidence ? [{ text: r.evidence, source: "The row's reading; no line was looked for", quoted: false }] : [], whole: false };
  return null;
}

const CLOSE_AFTER_MS = 150;

/** Where the popover hangs: from the tag's left side, from its right, or,
 *  when neither side has the room, pinned to the card's left edge and
 *  wrapped within the card. */
interface Placement {
  flip: boolean;
  style?: CSSProperties;
}
const FROM_LEFT: Placement = { flip: false };

function EvidenceTag({ e, scope }: { e: Evidence; scope: string }) {
  const popId = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  // A press that began inside the popover: the button's blur is not a leave.
  const downInside = useRef(false);
  // Focus put back on the tag by Escape must not open it again.
  const skipFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<Placement>(FROM_LEFT);

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
    setPlace(FROM_LEFT);
  };
  // Leaving with the mouse closes it after a beat, so the pointer can cross
  // the gap into the popover. A click pins it until Escape or a click outside.
  const hideSoon = () => {
    if (pinned) return;
    clearTimer();
    timer.current = window.setTimeout(close, CLOSE_AFTER_MS);
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
  // document in the capture phase, before the drawer's own listener. Focus
  // that sat inside the popover returns to the tag without reopening it.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      const hadFocus = !!wrap.current?.contains(document.activeElement);
      close();
      if (hadFocus && document.activeElement !== btn.current) {
        skipFocus.current = true;
        btn.current?.focus();
        skipFocus.current = false;
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Keep it on the card: when it would run past the card's right edge, hang
  // it from the tag's right side; when neither side has the room (a narrow
  // card), pin it to the card's left edge and let it wrap within the card.
  useLayoutEffect(() => {
    if (!open || !pop.current || !btn.current) return;
    const width = pop.current.getBoundingClientRect().width;
    const tag = btn.current.getBoundingClientRect();
    const box = wrap.current?.closest(".vc")?.getBoundingClientRect();
    const rightEdge = Math.min(window.innerWidth, box?.right ?? window.innerWidth) - 8;
    const leftEdge = Math.max(0, box?.left ?? 0) + 8;
    if (tag.left + width <= rightEdge) setPlace(FROM_LEFT);
    else if (tag.right - width >= leftEdge) setPlace({ flip: true });
    else {
      const wrapLeft = wrap.current?.getBoundingClientRect().left ?? tag.left;
      setPlace({ flip: false, style: { left: `${Math.round(leftEdge - wrapLeft)}px`, right: "auto", maxWidth: `${Math.max(120, Math.floor(rightEdge - leftEdge))}px` } });
    }
  }, [open]);

  const onBlur = (ev: FocusEvent<HTMLSpanElement>) => {
    if (downInside.current) return;
    if (!wrap.current?.contains(ev.relatedTarget as Node | null)) close();
  };
  const onFocus = () => {
    if (skipFocus.current) return;
    show();
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
        aria-describedby={open ? popId : undefined}
        title={e.row.label}
        onPointerEnter={mouseOnly(show)}
        onPointerLeave={mouseOnly(hideSoon)}
        onFocus={onFocus}
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
          className={`vc-pop${place.flip ? " flip" : ""}`}
          style={place.style}
          onPointerEnter={mouseOnly(show)}
          onPointerLeave={mouseOnly(hideSoon)}
        >
          <div className="vc-pop-h">
            <span>{e.label}</span>
            <a
              className="vc-pop-open"
              href={`#${rowAnchor(e.row.id, scope)}`}
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
          ) : e.lines.length ? (
            e.lines.map((l, i) => (
              <div className="vc-pop-line" key={i}>
                <p className="vc-pop-q">{l.quoted ? <>&ldquo;{l.text}&rdquo;</> : l.text}</p>
                <small className="vc-pop-s">{l.source}</small>
              </div>
            ))
          ) : (
            <p className="vc-pop-q">No line was found for this row. Open the row to see how it was read.</p>
          )}
          <small className="vc-pop-row">On the row: {e.row.label}</small>
        </div>
      )}
    </span>
  );
}

/** The lead of a bullet, in bold: up to the first colon or the end of the
 *  first sentence, whichever comes first, so a one-sentence bullet scans
 *  like the others. */
function splitLead(text: string): [string, string] {
  const first = sentences(text)[0] ?? "";
  let lead = first && text.startsWith(first) ? first : "";
  const colon = text.search(/:(\s|$)/);
  if (colon >= 0 && (!lead || colon + 1 < lead.length)) lead = text.slice(0, colon + 1);
  return lead ? [lead, text.slice(lead.length).trim()] : ["", text];
}

function Bullet({ b, byId, kind, scope }: { b: ReviewBullet; byId: Map<string, CardRow>; kind: "fit" | "gap"; scope: string }) {
  const cited = b.rowIds.map((id) => byId.get(id)).filter((r): r is CardRow => !!r);
  // A fit is as strong as its best row, a gap as open as its worst.
  const status: RowStatus = cited.length ? (kind === "gap" ? weakest(cited) : strongest(cited)) : "unknown";
  const text = b.text.trim();
  const [lead, rest] = splitLead(text);
  const tags = cited.map(evidenceOf).filter((e): e is Evidence => !!e);
  return (
    <li className="vc-bullet">
      <span className={`vc-bmark m-${status}`} role="img" aria-label={ROW_WORD[status]} title={ROW_WORD[status]}>
        {reviewMark(status)}
      </span>
      <div className="vc-btext">
        {lead ? <b>{lead}</b> : text}
        {lead && rest && " "}
        {lead && rest}
        {tags.length > 0 && " "}
        {tags.map((e) => (
          <EvidenceTag key={e.row.id} e={e} scope={scope} />
        ))}
      </div>
    </li>
  );
}

export default function ReviewBullets({ review, rows, anchorScope = "" }: { review: Review; rows: CardRow[]; anchorScope?: string }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (!review.fits.length && !review.gaps.length) return null;
  return (
    <>
      {review.fits.length > 0 && (
        <section className="vc-rsec">
          <h4 className="vc-sec">Why they fit the role</h4>
          <ul className="vc-bullets">
            {review.fits.map((b, i) => (
              <Bullet key={`f-${i}`} b={b} byId={byId} kind="fit" scope={anchorScope} />
            ))}
          </ul>
        </section>
      )}
      {review.gaps.length > 0 && (
        <section className="vc-rsec">
          <h4 className="vc-sec">Missing, or to confirm on a call</h4>
          <ul className="vc-bullets">
            {review.gaps.map((b, i) => (
              <Bullet key={`g-${i}`} b={b} byId={byId} kind="gap" scope={anchorScope} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
