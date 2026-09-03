"use client";
// Home: the exceptions the Jobs table can't show, grouped by rule, oldest
// first. Every row has the one or two actions that resolve it; anything
// heavier (a composer, a task) is handed to the page. Snooze, copy link and
// close role are small enough to live here.
import { useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import NoReplyPanel from "@/components/dashboard/email/NoReplyPanel";
import { RULE_KEYS, type RuleKey } from "@/lib/goals";
import { fmtDue } from "@/lib/reminders";
import type { AttentionData, AttentionRow } from "@/lib/server/home-goals";

export type AttentionAction = "inbox" | "nudge" | "email" | "checkin" | "offer" | "task" | "open" | "sourcing" | "job" | "changed";

const TITLE: Record<RuleKey, (days: number) => string> = {
  reply: () => "Waiting for your reply",
  contacted: () => "Contacted, no reply",
  interviewing: () => "Interviewing, gone quiet",
  offer: () => "Offer out, no answer",
  role: (d) => `Roles with no new applicants in ${d} days`,
  fdue: (d) => `Follow-ups due in the next ${d} days`,
};
const TONE: Record<RuleKey, "bad" | "warn" | "neu"> = { reply: "bad", contacted: "warn", interviewing: "warn", offer: "warn", role: "neu", fdue: "neu" };
const DEFAULT_OPEN: RuleKey[] = ["reply", "contacted", "interviewing", "offer"];

const when = (r: AttentionRow, today: string): string => {
  const d = `${r.days} day${r.days === 1 ? "" : "s"}`;
  switch (r.kind) {
    case "contacted":
      return `Contacted · ${d}, no reply`;
    case "interviewing":
      return `Interviewing · ${d} quiet`;
    case "fdue":
      return r.days === 0 ? "today" : r.days === 1 ? "tomorrow" : r.dueDay ? fmtDue(r.dueDay) : d;
    default:
      return d;
  }
};

export default function AttentionCard({
  attention,
  today,
  onAction,
}: {
  attention: AttentionData;
  today: string;
  onAction: (action: AttentionAction, row: AttentionRow) => void;
}) {
  const { token } = useDash();
  const [open, setOpen] = useState<Set<RuleKey>>(new Set(DEFAULT_OPEN));
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [noReplyFor, setNoReplyFor] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const toggle = (k: RuleKey) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const drop = (id: string) => setGone((s) => new Set(s).add(id));

  const snooze = async (r: AttentionRow) => {
    setBusy(r.id);
    const res = await fetch("/api/dashboard/home/attention", { method: "POST", headers: auth, body: JSON.stringify({ key: r.id, today }) }).catch(() => null);
    setBusy(null);
    if (res?.ok) drop(r.id);
    else setNotice("Couldn't snooze that. Try again.");
  };
  const copy = async (r: AttentionRow) => {
    if (!r.url) return;
    try {
      await navigator.clipboard.writeText(r.url);
      setCopied(r.id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setNotice(`Copy this link: ${r.url}`);
    }
  };
  const closeRole = async (r: AttentionRow) => {
    if (!r.jobId) return;
    setBusy(r.id);
    const res = await fetch(`/api/dashboard/jobs/${r.jobId}`, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "closed" }) }).catch(() => null);
    setBusy(null);
    setConfirmClose(null);
    if (res?.ok) {
      drop(r.id);
      onAction("changed", r);
    } else setNotice("Couldn't close the role. Nothing changed; try it from the job page.");
  };

  const groups = attention.groups.map((g) => ({ ...g, rows: g.rows.filter((r) => !gone.has(r.id)) })).filter((g) => g.rows.length > 0);
  const rules = attention.rules;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className="hm-card">
      <div className="hm-ch">
        <div>
          <h4>Needs attention</h4>
          <p className="cs">oldest first · click a row to open it · hover for actions</p>
        </div>
      </div>
      {notice && <p className="cv2d-err">{notice}</p>}

      {groups.length === 0 && (
        <p className="hm-empty">Nothing needs a look. Everyone in play has had activity inside the rules&apos; windows, and every open role has had someone new recently.</p>
      )}

      {groups.map((g) => (
        <div className={`hm-grp${open.has(g.key) ? " open" : ""}`} key={g.key}>
          <button type="button" onClick={() => toggle(g.key)} aria-expanded={open.has(g.key)}>
            <span>{TITLE[g.key](rules[g.key].days)}</span>
            <span className={`hm-chip ${TONE[g.key]}`}>{g.total}</span>
            <span className="chev">›</span>
          </button>
          {open.has(g.key) && (
            <ul>
              {g.rows.map((r) => {
                const primaryOpen: AttentionAction = r.kind === "reply" ? "inbox" : r.kind === "role" ? "job" : "open";
                return (
                  <li key={r.id} onClick={() => onAction(primaryOpen, r)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && onAction(primaryOpen, r)}>
                    <b>{r.name}</b>
                    <span className={`w${r.hot ? " hot" : ""}`}>{when(r, today)}</span>
                    {r.jobTitle && <span className="j">{r.jobTitle}</span>}
                    {r.ladder && <span className="lad">{r.ladder}</span>}
                    <span className="acts" onClick={stop}>
                      {r.kind === "reply" && (
                        <button type="button" className="pri" onClick={() => onAction("inbox", r)}>
                          Open in Inbox
                        </button>
                      )}
                      {r.kind === "contacted" && (
                        <>
                          {r.threadId ? (
                            <button type="button" className="pri" onClick={() => onAction("nudge", r)}>
                              Nudge
                            </button>
                          ) : (
                            <button type="button" className="pri" onClick={() => onAction("email", r)}>
                              Email
                            </button>
                          )}
                          <button type="button" onClick={() => setNoReplyFor(noReplyFor === r.id ? null : r.id)}>
                            No reply
                          </button>
                        </>
                      )}
                      {r.kind === "interviewing" && (
                        <>
                          <button type="button" className="pri" onClick={() => onAction("checkin", r)}>
                            Check in
                          </button>
                          <button type="button" onClick={() => onAction("task", r)}>
                            Add a task
                          </button>
                        </>
                      )}
                      {r.kind === "offer" && (
                        <>
                          <button type="button" className="pri" onClick={() => onAction("offer", r)}>
                            Offer times
                          </button>
                          <button type="button" onClick={() => onAction("task", r)}>
                            Add a task
                          </button>
                        </>
                      )}
                      {r.kind === "role" && (
                        <>
                          <button type="button" className="pri" onClick={() => onAction("sourcing", r)}>
                            Start a sourcing run
                          </button>
                          <button type="button" onClick={() => copy(r)}>
                            {copied === r.id ? "Copied" : "Copy link"}
                          </button>
                          {r.closable && (
                            <button type="button" className="danger" onClick={() => setConfirmClose(confirmClose === r.id ? null : r.id)}>
                              Close role
                            </button>
                          )}
                        </>
                      )}
                      {r.kind === "fdue" && (
                        <button type="button" className="pri" onClick={() => onAction("open", r)}>
                          Open
                        </button>
                      )}
                      {r.kind !== "reply" && (
                        <button type="button" disabled={busy === r.id} onClick={() => snooze(r)} title="Hide this for seven days">
                          Snooze
                        </button>
                      )}
                    </span>
                    {noReplyFor === r.id && r.candidateKey && (
                      <span onClick={stop} style={{ flexBasis: "100%" }}>
                        <NoReplyPanel
                          candKey={r.candidateKey}
                          first={r.name.split(/\s+/)[0] || r.name}
                          threadId={r.threadId}
                          jobId={r.jobId}
                          jobTitle={r.jobTitle}
                          subject={r.subject}
                          onDone={() => {
                            setNoReplyFor(null);
                            drop(r.id);
                            onAction("changed", r);
                          }}
                          onCancel={() => setNoReplyFor(null)}
                        />
                      </span>
                    )}
                    {confirmClose === r.id && (
                      <span className="nr-panel" onClick={stop}>
                        <b>Close {r.name}?</b>
                        <span>It leaves the board and the pipeline stays as it is. You can reopen it from Jobs.</span>
                        <button type="button" className="tkm-save" disabled={busy === r.id} onClick={() => closeRole(r)}>
                          Close role
                        </button>
                        <button type="button" className="tkm-cancel" onClick={() => setConfirmClose(null)}>
                          Keep it open
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
              {g.total > g.rows.length && <li className="more">and {g.total - g.rows.length} more</li>}
            </ul>
          )}
        </div>
      ))}

      <div className="hm-attn-foot">
        Rules: {RULE_KEYS.filter((k) => rules[k].on)
          .map((k) =>
            k === "reply" ? `reply waiting ${rules.reply.days}d`
            : k === "contacted" ? `Contacted with no reply ${rules.contacted.days}d`
            : k === "interviewing" ? `Interviewing with no activity ${rules.interviewing.days}d`
            : k === "offer" ? `offer ${rules.offer.days}d`
            : k === "role" ? `role quiet ${rules.role.days}d`
            : `follow-ups within ${rules.fdue.days}d`
          )
          .join(" · ")}
        . Activity means a stage move, an email either way, a task done or a note. Anyone with an open reminder, check-back or no-reply mark is left to the Inbox. Snooze hides a row for seven days. The owner changes the rules in Settings.
      </div>
    </div>
  );
}
