"use client";
// The strip under the drawer header while working through the Inbox: what
// this item is, what clears it, and the way on. After the work is done it
// flips to "Handled" with Next — it never jumps by itself, so a note or a
// shortlist can still happen on this person first.
import KindIcon from "@/components/dashboard/tasks/KindIcon";
import {
  KIND_ICON,
  KIND_TONE,
  isTask,
  reasonLabel,
  stripHint,
  type InboxItem,
} from "@/components/dashboard/inbox/types";

// Date-only strings are calendar days (noon local avoids a UTC slip);
// instants are converted to the viewer's zone.
const fmtDay = (iso: string) =>
  (iso.length === 10 ? new Date(iso + "T12:00:00") : new Date(iso)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
const fmtWhen = (item: InboxItem, today: string) => {
  if (item.dueDate) {
    const t = item.dueTime ? ` · ${item.dueTime}` : "";
    if (item.dueDate === today) return `Due today${t}`;
    return `${item.overdue ? "Overdue · was due " : "Due "}${fmtDay(item.dueDate)}${t}`;
  }
  const d = new Date(item.at);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-CA") === today ? `${time} today` : fmtDay(item.at);
};

export default function InboxStrip({
  item,
  today,
  handledReason,
  remaining,
  hasNext,
  busy,
  onDone,
  onSkip,
  onNext,
  onClose,
}: {
  item: InboxItem;
  today: string;
  /** Set once this item has been dealt with in this session. */
  handledReason: string | null;
  remaining: number;
  hasNext: boolean;
  busy: boolean;
  onDone: () => void;
  onSkip: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const tone = KIND_TONE[item.kind];
  if (handledReason) {
    // "gone" = it left the list for a reason this session didn't cause
    // (rescheduled, a teammate acted, the date moved): say so, don't claim it.
    const gone = handledReason === "gone";
    return (
      <div className="ibs handled" role="status">
        <span className={`ib-kind ${tone}`}>
          <KindIcon kind={KIND_ICON[item.kind]} className="tk-ico" />
        </span>
        <span className={`ibs-txt${gone ? "" : " ok"}`}>
          <b>
            {gone
              ? "No longer in your Inbox"
              : `✓ ${isTask(item.kind) && handledReason !== "email" ? "Task done" : `Handled · ${reasonLabel(handledReason, item.kind)}`}`}
          </b>
          <span>{remaining ? `${remaining} left for today` : "Your Inbox is clear for today"}</span>
        </span>
        {hasNext ? (
          <button type="button" className="ibs-btn pri" onClick={onNext}>
            Next ›
          </button>
        ) : (
          <button type="button" className="ibs-btn pri" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    );
  }
  const doneLabel = item.kind === "fdue" ? "Mark contacted" : isTask(item.kind) ? "Mark done" : "Done";
  return (
    <div className={`ibs ${tone}`} role="status">
      <span className={`ib-kind ${tone}`}>
        <KindIcon kind={KIND_ICON[item.kind]} className="tk-ico" />
      </span>
      <span className="ibs-txt">
        <b>{item.title}</b>
        <span>
          <em className={item.overdue ? "bad" : ""}>{fmtWhen(item, today)}</em>
          {stripHint(item) ? ` · ${stripHint(item)}` : ""}
        </span>
      </span>
      <button type="button" className="ibs-btn" disabled={busy} onClick={onDone} title="Clear without acting">
        {busy ? "…" : doneLabel}
      </button>
      {hasNext && (
        <button type="button" className="ibs-btn" onClick={onSkip} title="Leave it, move on">
          Skip ›
        </button>
      )}
    </div>
  );
}
