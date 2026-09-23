"use client";
// A company's name on the report card, with a snapshot of its LinkedIn page
// on hover: what it does, its size, when it was founded, where it is, its
// website, and the person's time there. The name is a button when the card
// knows the company (a snapshot, or at least the page's address); otherwise
// the plain name as before. The popover mirrors the review's evidence tags:
// open on hover, focus or a click; closed on mouse leave after a beat, a blur
// outside, Escape or a press outside; hung from the name's left, or from its
// right when the card's edge is near.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent, type RefObject } from "react";
import { companyKey, sizeWord, type CompanyLookup, type CompanySnapshot } from "@/lib/company-snapshot";

const CLOSE_AFTER_MS = 150;

/** Where the popover hangs: from the name's left side, from its right, or,
 *  when neither side has the room, pinned to the card's left edge. */
interface Placement {
  flip: boolean;
  style?: CSSProperties;
}
const FROM_LEFT: Placement = { flip: false };

const fetchedOn = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

const withScheme = (site: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`);

/** "acme.com" for https://www.acme.com/about; the text itself when it is not an address. */
const hostOf = (site: string) => {
  try {
    return new URL(withScheme(site)).host.replace(/^www\./, "") || site;
  } catch {
    return site;
  }
};

/** "Software Development · privately held" */
const kindLine = (s: CompanySnapshot) => [s.industry, s.companyType ? s.companyType.toLowerCase() : ""].filter(Boolean).join(" · ");

function Popover({ id, name, snapshot, linkedinUrl, tenure, place, popRef, onEnter, onLeave }: { id: string; name: string; snapshot: CompanySnapshot | null; linkedinUrl: string | null; tenure?: string; place: Placement; popRef: RefObject<HTMLDivElement | null>; onEnter: (ev: PointerEvent) => void; onLeave: (ev: PointerEvent) => void }) {
  const shown = snapshot?.name || name;
  const line = snapshot ? kindLine(snapshot) : "";
  const size = snapshot?.employeeRange ? { range: snapshot.employeeRange, word: sizeWord(snapshot.employees) } : null;
  const fetched = fetchedOn(snapshot?.fetchedAt ?? null);
  return (
    <div ref={popRef} id={id} role="dialog" aria-label={`About ${shown}`} className={`vc-copop${place.flip ? " flip" : ""}`} style={place.style} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <div className="vc-copop-h">
        <span className="vc-copop-i" aria-hidden="true">
          {shown.trim().charAt(0).toUpperCase()}
        </span>
        <div className="vc-copop-hm">
          <b>{shown}</b>
          {line && <small>{line}</small>}
        </div>
        {linkedinUrl && (
          <a href={linkedinUrl} target="_blank" rel="noreferrer">
            LinkedIn ↗
          </a>
        )}
      </div>
      {snapshot ? (
        <>
          {snapshot.tagline && <p className="vc-copop-tag">{snapshot.tagline}</p>}
          {(size || snapshot.founded != null || snapshot.hq || snapshot.website || tenure) && (
            <dl>
              {size && (
                <>
                  <dt>Size</dt>
                  <dd>
                    {size.range}
                    {size.word && <small> · {size.word}</small>}
                  </dd>
                </>
              )}
              {snapshot.founded != null && (
                <>
                  <dt>Founded</dt>
                  <dd>{snapshot.founded}</dd>
                </>
              )}
              {snapshot.hq && (
                <>
                  <dt>HQ</dt>
                  <dd>{snapshot.hq}</dd>
                </>
              )}
              {snapshot.website && (
                <>
                  <dt>Website</dt>
                  <dd>
                    <a href={withScheme(snapshot.website)} target="_blank" rel="noreferrer">
                      {hostOf(snapshot.website)}
                    </a>
                  </dd>
                </>
              )}
              {tenure && (
                <>
                  <dt>Their time here</dt>
                  <dd>{tenure}</dd>
                </>
              )}
            </dl>
          )}
          <small className="vc-copop-f">From the company&apos;s LinkedIn page{fetched && ` · fetched ${fetched}`}</small>
        </>
      ) : (
        <p className="vc-copop-tag">No company page on file yet.</p>
      )}
    </div>
  );
}

function CompanyButton({ name, snapshot, linkedinUrl, tenure }: { name: string; snapshot: CompanySnapshot | null; linkedinUrl: string | null; tenure?: string }) {
  const popId = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  // A press that began inside the popover: the button's blur is not a leave.
  const downInside = useRef(false);
  // Focus put back on the name by Escape must not open it again.
  const skipFocus = useRef(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<Placement>(FROM_LEFT);

  const clearTimer = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const show = () => {
    clearTimer();
    setOpen(true);
  };
  const close = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPinned(false);
    setPlace(FROM_LEFT);
  }, [clearTimer]);
  // Leaving with the mouse closes it after a beat, so the pointer can cross
  // the gap into the popover. A click pins it until Escape or a press outside.
  const hideSoon = () => {
    if (pinned) return;
    clearTimer();
    timer.current = window.setTimeout(close, CLOSE_AFTER_MS);
  };
  // Hover is a mouse thing: a touch that lands on the name is a click.
  const onEnter = (ev: PointerEvent) => {
    if (ev.pointerType === "mouse") show();
  };
  const onLeave = (ev: PointerEvent) => {
    if (ev.pointerType === "mouse") hideSoon();
  };

  useEffect(() => clearTimer, [clearTimer]);

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
  }, [open, close]);

  // Keep it on the card: when it would run past the card's right edge, hang
  // it from the name's right side; when neither side has the room (a narrow
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

  // Escape closes it wherever the focus is (a hover needs none), and never
  // reaches the drawer around the card, which closes on Escape too: caught
  // at the document in the capture phase, before the drawer's own listener,
  // the way the review's evidence popover does it. Focus that sat inside the
  // popover returns to the name without reopening it.
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
  }, [open, close]);
  const onBlur = (ev: FocusEvent<HTMLSpanElement>) => {
    if (downInside.current) return;
    if (!wrap.current?.contains(ev.relatedTarget as Node | null)) close();
  };
  const onFocus = () => {
    if (skipFocus.current) return;
    show();
  };

  return (
    <span className="vc-cowrap" ref={wrap} onBlur={onBlur}>
      <button
        type="button"
        ref={btn}
        className="vc-co"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        title={snapshot ? `About ${snapshot.name || name}, from its LinkedIn page` : "Open the company on LinkedIn"}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocus={onFocus}
        onClick={() => {
          if (open && pinned) close();
          else {
            setPinned(true);
            show();
          }
        }}
      >
        {name}
      </button>
      {open && <Popover id={popId} name={name} snapshot={snapshot} linkedinUrl={linkedinUrl} tenure={tenure} place={place} popRef={pop} onEnter={onEnter} onLeave={onLeave} />}
    </span>
  );
}

/** The company's name as the card shows it: a button with the snapshot on
 *  hover when the card knows the company, else the plain name.
 *  `tenure` is the person's time there, for the popover's last row. */
export function CompanyName({ name, lookup, tenure }: { name: string; lookup?: CompanyLookup; tenure?: string }) {
  const entry = lookup?.[companyKey(name)];
  if (!entry || (!entry.snapshot && !entry.linkedinUrl)) return <b>{name}</b>;
  return <CompanyButton name={name} snapshot={entry.snapshot} linkedinUrl={entry.snapshot?.linkedinUrl || entry.linkedinUrl} tenure={tenure} />;
}
