"use client";
// The strip under the drawer header while working through the Inbox: what
// this item is, what clears it, the quick actions for its kind, and the way
// on. After the work is done it flips to "Handled" with Next — it never
// jumps by itself, so a note or a shortlist can still happen on this person
// first. A quick action never sends: it opens the composer with the right
// template merged; Send does the bookkeeping.
import { useState } from "react";
import KindIcon from "@/components/dashboard/tasks/KindIcon";
import NoReplyPanel from "@/components/dashboard/email/NoReplyPanel";
import { actionsFor, outcomeLabel, type QuickAction } from "@/lib/quick-actions";
import {
  KIND_ICON,
  KIND_LABEL,
  KIND_TONE,
  isTask,
  reasonLabel,
  stripHint,
  type InboxItem,
} from "@/components/dashboard/inbox/types";

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
/** "Asked to hear from you in November" → "November". */
const monthOf = (item: InboxItem) => {
  const m = item.title.match(/ in ([A-Z][a-z]+(?: \d{4})?)$/);
  return m ? m[1] : null;
};
const ACTION_ICON: Record<string, string> = { call: "call", no: "task", file: "note", ack: "request", open: "request", reply: "email" };

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
  onAction,
  onNoReply,
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
  /** The action, and the kind it belongs to (the lead's, or a rider's). */
  onAction: (a: QuickAction, kind: string) => void;
  /** "No reply" confirmed from the panel here. */
  onNoReply: (r: { checkBack: string | null; staged: boolean }) => void;
}) {
  const [nrOpen, setNrOpen] = useState(false);
  const tone = KIND_TONE[item.kind];
  const also = item.also || [];
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
              : `✓ ${isTask(item.kind) && item.kind !== "remind" && item.kind !== "cback" && handledReason !== "email" ? "Task done" : `Handled · ${reasonLabel(handledReason, item.kind)}`}`}
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
  const doneLabel = item.kind === "fdue" ? "Mark contacted" : item.kind === "remind" ? "Let it go" : isTask(item.kind) ? "Mark done" : "Done";
  // A task leading the row has no buttons of its own; the person's other
  // open item (their application, their resume drop) still gets its rule.
  let actionKind = item.kind;
  let actions = actionsFor(item.kind, { hasRole: Boolean(item.jobId), month: monthOf(item), nudges: item.nudges });
  if (actions.length === 0) {
    for (const x of also) {
      const a = actionsFor(x.kind, { hasRole: Boolean(x.jobId || item.jobId), month: monthOf({ ...item, title: x.title }) });
      if (a.length) {
        actions = a;
        actionKind = x.kind;
        break;
      }
    }
  }
  return (
    <div className={`ibs ${tone}`} role="status">
      <span className={`ib-kind ${tone}`}>
        <KindIcon kind={KIND_ICON[item.kind]} className="tk-ico" />
      </span>
      <span className="ibs-txt">
        <b>
          {item.title}
          {item.kind === "remind" && item.extra ? <span className="ibs-lad">{item.extra}</span> : null}
        </b>
        <span>
          <em className={item.overdue ? "bad" : ""}>{fmtWhen(item, today)}</em>
          {stripHint(item) ? ` · ${stripHint(item)}` : ""}
        </span>
      </span>
      {actions.length === 0 && (
        <button type="button" className="ibs-btn" disabled={busy} onClick={onDone} title="Clear without acting">
          {busy ? "…" : doneLabel}
        </button>
      )}
      {actions.length === 0 && hasNext && (
        <button type="button" className="ibs-btn" onClick={onSkip} title="Leave it, move on">
          Skip ›
        </button>
      )}
      {actions.length > 0 && (
        <div className="ibs-acts">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`qa${a.primary ? " pri" : ""}${a.danger ? " bad" : ""}`}
              title={a.noReply ? "Stop chasing them. No email goes out." : a.template ? `Opens the composer with "${a.templateName || a.template}" merged for them` : "Opens the composer"}
              onClick={() => (a.noReply ? setNrOpen(true) : onAction(a, actionKind))}
            >
              <KindIcon kind={ACTION_ICON[a.id] || "email"} className="tk-ico" />
              {a.label}
            </button>
          ))}
          <span className="ibs-more">
            {item.kind !== "remind" && item.kind !== "cback" && (
              <button type="button" disabled={busy} onClick={onDone} title="Clear without acting">
                {busy ? "…" : doneLabel}
              </button>
            )}
            {hasNext && (
              <>
                {item.kind !== "remind" && item.kind !== "cback" ? "·" : ""}
                <button type="button" onClick={onSkip} title="Leave it, move on">
                  Skip ›
                </button>
              </>
            )}
          </span>
        </div>
      )}
      {nrOpen && item.candidateKey && (
        <NoReplyPanel
          candKey={item.candidateKey}
          first={(item.candidateName || "them").split(/\s+/)[0]}
          threadId={item.threadId}
          jobId={actionKind === item.kind ? item.jobId : also.find((x) => x.kind === actionKind)?.jobId || item.jobId}
          subject={item.subject}
          onCancel={() => setNrOpen(false)}
          onDone={(r) => {
            setNrOpen(false);
            onNoReply(r);
          }}
        />
      )}
      {actions.length > 0 && (
        <span className="ibs-also">
          {actionKind !== item.kind ? `Buttons are for their ${KIND_LABEL[actionKind].toLowerCase()} · ` : ""}
          Every button opens the composer first, and says there what Send will do before you send it.
          {also.length > 0 && (
            <>
              {" · "}Also open for them: <b>{also.map((x) => KIND_LABEL[x.kind]).join(" · ")}</b>
            </>
          )}
        </span>
      )}
      {actions.length === 0 && also.length > 0 && (
        <span className="ibs-also">
          Also open for them: <b>{also.map((x) => KIND_LABEL[x.kind]).join(" · ")}</b>
        </span>
      )}
    </div>
  );
}
