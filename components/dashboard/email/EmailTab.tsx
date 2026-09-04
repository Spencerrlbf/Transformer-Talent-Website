"use client";
// The drawer's Email tab: this candidate's conversations, chat-style.
// Threads group by the provider's thread id (what's one conversation in
// Outlook/Gmail is one here); each bubble is that message's own words, the
// quoted chain sits behind a toggle. Quick reply sends a true threaded
// reply; "Open in composer" hands the same text to the full composer.
import { useCallback, useEffect, useRef, useState } from "react";
import RemindChips from "@/components/dashboard/email/RemindChips";
import NoReplyPanel from "@/components/dashboard/email/NoReplyPanel";
import { fmtDue, localDay as todayDay, reminderDue, type RemindChoice } from "@/lib/reminders";
import { useDash } from "@/components/dashboard/DashShell";
import EmailModal from "@/components/dashboard/email/EmailModal";

type Msg = {
  id: string;
  direction: "out" | "in";
  memberEmail: string;
  subject: string;
  bodyHtml: string | null;
  bodyText: string;
  quotedText: string;
  messageId: string;
  createdAt: string;
};
type Thread = { id: string; subject: string; messages: Msg[]; lastAt: string; awaiting: boolean };
type Data = {
  connected: boolean;
  address: string;
  awaiting: number;
  threads: Thread[];
  /** Teammates' conversations the org's private setting keeps from this viewer. */
  hiddenThreads?: number;
  /** This seat's live reply reminders, by thread. */
  reminders?: { id: string; threadId: string; dueDate: string; jobId?: string | null }[];
  /** "No reply" mark on this person, when live. */
  noReply?: { markedAt: string; checkBackAt: string | null; threadId: string | null } | null;
};

const localDay = (d: Date) => d.toLocaleDateString("en-CA");
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (localDay(d) === localDay(new Date())) return `Today, ${time}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
};

/** A thread subject came from a mail client (or a candidate): never let it
 *  trip the composer's merge-field check or the 300-char limit. */
const replySubject = (s: string) => `Re: ${s.replace(/\{\{|\}\}/g, "").slice(0, 290)}`;

/** The newest message with a real provider id — what a reply threads under. */
const replyTarget = (t: Thread): Msg | null => {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.messageId && !m.messageId.startsWith("local-")) return m;
  }
  return null;
};

export default function EmailTab({
  candKey,
  name,
  onAwaiting,
  openThreadId,
  completeTaskId,
  inboxThreadId,
  onSent,
  openCompose,
  onSilent,
  onNoReply,
}: {
  candKey: string;
  name: string;
  /** Reports the awaiting-reply count so the tab badge stays current. */
  onAwaiting?: (n: number) => void;
  /** Inbox: open on this thread rather than the newest. */
  openThreadId?: string | null;
  /** Inbox: the email task a send from here fulfils. */
  completeTaskId?: string | null;
  /** Inbox: the thread a fresh (unthreaded) email answers. */
  inboxThreadId?: string | null;
  /** Inbox: a send went out (quick reply or composer), with what the server did. */
  onSent?: (result?: { staged: string | null; taskDone: boolean; reminded?: string | null }) => void;
  /** Inbox quick action: open the composer on the current thread with a template. */
  openCompose?: {
    nonce: number;
    template: string | null;
    templateName?: string;
    button?: string;
    reply?: boolean;
    after?: { stage: "contacted" | "rejected"; jobId?: string | null };
    outcome?: string;
    allowSilent?: boolean;
    remind?: boolean;
  } | null;
  onSilent?: () => void;
  /** "No reply" confirmed from a thread header here. */
  onNoReply?: (r: { checkBack: string | null; staged: boolean }) => void;
}) {
  const { token, reminderDays } = useDash();
  const first = name.split(/\s+/)[0] || name;

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [err, setErr] = useState("");
  // "Remind me if no reply" for each thread's quick-reply box: the seat
  // default until touched. Change/Cancel on a live reminder patch its task.
  const [remindQ, setRemindQ] = useState<Record<string, RemindChoice>>({});
  const remindFor = (id: string): RemindChoice => (id in remindQ ? remindQ[id] : reminderDays ? { days: reminderDays } : null);
  const [changing, setChanging] = useState<string | null>(null);
  const [nrThread, setNrThread] = useState<string | null>(null);
  const patchReminder = async (id: string, body: Record<string, unknown>) => {
    await fetch(`/api/dashboard/tasks/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setChanging(null);
    load();
  };
  const [compose, setCompose] = useState<null | {
    threadId?: string;
    reply?: { messageId: string; subject: string };
    initialText?: string;
    /** Quick action: template + outcome handed in from the Inbox strip. */
    template?: string | null;
    templateName?: string;
    button?: string;
    threadSubject?: string;
    after?: { stage: "contacted" | "rejected"; jobId?: string | null };
    outcome?: string;
    allowSilent?: boolean;
    remind?: boolean;
    nonce?: number;
  }>(null);

  // A quick action from the Inbox strip: compose (as a reply when the open
  // thread has a provider id) with the named template already merged. Each
  // request is handled once — a cancelled composer never reopens itself.
  const handledNonce = useRef(0);
  useEffect(() => {
    if (!openCompose || !data || openCompose.nonce === handledNonce.current) return;
    handledNonce.current = openCompose.nonce;
    const t = data.threads.find((x) => x.id === (openThreadId || open)) || data.threads[0];
    const target = t ? replyTarget(t) : null;
    setCompose({
      threadId: t?.id,
      reply: openCompose.reply && t && target ? { messageId: target.messageId, subject: t.subject } : undefined,
      threadSubject: t?.subject,
      template: openCompose.template,
      templateName: openCompose.templateName,
      button: openCompose.button,
      after: openCompose.after,
      outcome: openCompose.outcome,
      allowSilent: openCompose.allowSilent,
      remind: openCompose.remind,
      nonce: openCompose.nonce,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCompose?.nonce, data === null]);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);

  const load = useCallback(() => {
    setSyncing(true);
    // Bypass every cache layer: a poll that returns a stale body is worse
    // than no poll.
    fetch(`/api/dashboard/email/threads?key=${candKey}&_=${Date.now()}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Data>;
      })
      .then((d) => {
        setData(d);
        setError(false);
        setLastSync(new Date());
        setOpen((cur) => (cur && d.threads.some((t) => t.id === cur) ? cur : d.threads[0]?.id || null));
        onAwaiting?.(d.awaiting);
      })
      .catch(() => setError(true))
      .finally(() => setSyncing(false));
  }, [candKey, token, onAwaiting]);

  useEffect(load, [load]);

  // Opened from the Inbox on a specific thread (a person can have two).
  useEffect(() => {
    if (openThreadId) setOpen(openThreadId);
  }, [openThreadId]);

  // Replies arrive by webhook while the tab is open: poll while mounted and
  // refetch the moment the window regains focus (coming back from the mail
  // client is exactly when a reply is expected).
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") load();
    };
    const id = window.setInterval(tick, 15_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  const connect = async () => {
    setConnecting(true);
    try {
      const r = await fetch("/api/dashboard/email/connect", { headers: { Authorization: `Bearer ${token}` } });
      const j = (await r.json()) as { url?: string };
      if (j.url) {
        window.location.href = j.url;
        return;
      }
    } catch {
      /* fall through */
    }
    setConnecting(false);
  };

  const quickReply = async (t: Thread) => {
    const text = (drafts[t.id] || "").trim();
    if (!text || sending) return;
    const target = replyTarget(t);
    setSending(t.id);
    setErr("");
    try {
      const r = await fetch("/api/dashboard/email/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateKey: candKey,
          subject: replySubject(t.subject),
          text,
          ...(target ? { replyToMessageId: target.messageId } : {}),
          ...(completeTaskId ? { completeTaskId } : {}),
          // A quick reply with no provider target (local-only thread) still
          // answers this conversation.
          ...(!target ? { inboxThreadId: t.id } : {}),
          today: new Date().toLocaleDateString("en-CA"),
          remind: remindFor(t.id),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; staged?: string | null; taskDone?: boolean; reminded?: string | null };
      if (r.ok && j.ok) {
        setDrafts((d) => ({ ...d, [t.id]: "" }));
        load();
        onSent?.({ staged: j.staged ?? null, taskDone: Boolean(j.taskDone), reminded: j.reminded ?? null });
      } else if (j.error === "not_connected" || j.error === "grant_invalid") {
        setErr("Your email connection expired — reconnect from the Team page, then try again.");
      } else if (j.error === "no_candidate_email") {
        setErr(`No email on file for ${first}.`);
      } else {
        setErr("Sending failed — nothing went out. Try again in a moment.");
      }
    } catch {
      setErr("Network error — nothing went out. Try again.");
    }
    setSending(null);
  };

  return (
    <div className="emc">
      {error && <p className="cv2d-err">Couldn&apos;t load emails. Reopen to try again.</p>}
      {!data && !error && <p className="dash-muted emc-loading">Loading…</p>}

      {data && (
        <>
          <div className="emc-strip">
            {data.connected ? (
              <span>
                Sending as <b>{data.address}</b> · replies from {first} land here automatically
                <button
                  type="button"
                  className="emc-live"
                  title="Checks for new replies every 15 seconds — click to check now"
                  onClick={load}
                  disabled={syncing}
                >
                  <i className={`emc-livedot${syncing ? " busy" : ""}`} />
                  {syncing
                    ? "Checking…"
                    : lastSync
                      ? `Live · updated ${lastSync.toLocaleTimeString("en-GB")}`
                      : "Live"}
                  <span className="emc-refresh">↻</span>
                </button>
              </span>
            ) : (
              <span>Connect your inbox to email {first} from here — sends come from your own address.</span>
            )}
            {data.connected ? (
              <button className="emc-btn" onClick={() => setCompose({})}>
                NEW EMAIL →
              </button>
            ) : (
              <button className="emc-btn" onClick={connect} disabled={connecting}>
                {connecting ? "OPENING…" : "CONNECT EMAIL →"}
              </button>
            )}
          </div>

          {(data.hiddenThreads || 0) > 0 && (
            <p className="emc-hidden">
              {data.hiddenThreads} conversation{data.hiddenThreads === 1 ? "" : "s"} with {first} in
              {data.hiddenThreads === 1 ? " a teammate's mailbox is" : " teammates' mailboxes are"} private to them.
            </p>
          )}

          {data.threads.length === 0 && (
            <div className="emc-empty">
              <b>No emails with {first} yet.</b>
              Send the first one and the conversation will build here, replies included.
            </div>
          )}

          {data.threads.map((t) => {
            const isOpen = open === t.id;
            const hasInbound = t.messages.some((m) => m.direction === "in");
            return (
              <div className={`emc-thread${isOpen ? " open" : ""}`} key={t.id}>
                <div className="emc-head" onClick={() => setOpen(isOpen ? null : t.id)}>
                  <span className="emc-subj">{t.subject}</span>
                  {data.noReply && (!data.noReply.threadId || data.noReply.threadId === t.id) ? (
                    <span className="emc-chip nr" title="You stopped chasing them; a reply or a new email clears this">
                      No reply · {new Date(data.noReply.markedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </span>
                  ) : (
                    <span className={`emc-chip ${t.awaiting ? "wait" : "done"}`}>
                      {t.awaiting ? "Awaiting your reply" : hasInbound ? "Replied" : "Sent"}
                    </span>
                  )}
                  <span className="emc-meta">
                    {t.messages.length} message{t.messages.length === 1 ? "" : "s"} · {fmtWhen(t.lastAt)}
                  </span>
                  {!(data.noReply && (!data.noReply.threadId || data.noReply.threadId === t.id)) && (
                    <button
                      type="button"
                      className="emc-nr"
                      title="Stop chasing them. No email goes out."
                      onClick={(e) => {
                        e.stopPropagation();
                        setNrThread(nrThread === t.id ? null : t.id);
                      }}
                    >
                      No reply
                    </button>
                  )}
                  <span className="emc-caret">{isOpen ? "▾" : "▸"}</span>
                </div>
                {nrThread === t.id && (
                  <div className="emc-nrwrap">
                    <NoReplyPanel
                      candKey={candKey}
                      first={first}
                      threadId={t.id}
                      jobId={data.reminders?.find((r) => r.threadId === t.id)?.jobId || null}
                      subject={t.subject}
                      onCancel={() => setNrThread(null)}
                      onDone={(r) => {
                        setNrThread(null);
                        load();
                        onNoReply?.(r);
                      }}
                    />
                  </div>
                )}

                {isOpen && (
                  <>
                    {(() => {
                      const rem = data.reminders?.find((r) => r.threadId === t.id);
                      if (!rem) return null;
                      return (
                        <div className="emc-remind">
                          <span>
                            ↺ <b>Reminder {fmtDue(rem.dueDate)}</b> if {first} hasn&apos;t replied
                          </span>
                          {changing === rem.id ? (
                            <RemindChips
                              compact
                              label="Move to"
                              value={null}
                              today={todayDay()}
                              onChange={(v) => {
                                const due = reminderDue(todayDay(), v);
                                if (due) patchReminder(rem.id, { dueDate: due });
                              }}
                            />
                          ) : (
                            <span className="a">
                              <button type="button" onClick={() => setChanging(rem.id)}>
                                Change
                              </button>
                              <button type="button" onClick={() => patchReminder(rem.id, { status: "done", endedReason: "cancelled" })}>
                                Cancel
                              </button>
                            </span>
                          )}
                        </div>
                      );
                    })()}
                    <div className="emc-conv">
                      {t.messages.map((m) => {
                        const me = m.direction === "out";
                        const showQ = Boolean(quotes[m.id]);
                        return (
                          <div className={`emc-msg ${me ? "me" : "them"}`} key={m.id}>
                            <span className="who">
                              {me ? "You" : first} · {fmtWhen(m.createdAt)}
                            </span>
                            {me && m.bodyHtml ? (
                              // Sanitized server-side at write time (rebuild-only allowlist).
                              <div className="bub" dangerouslySetInnerHTML={{ __html: m.bodyHtml }} />
                            ) : (
                              <div className="bub pre">{m.bodyText || "(no text, attachment only)"}</div>
                            )}
                            {!me && m.quotedText && (
                              <>
                                <button
                                  type="button"
                                  className="emc-qtoggle"
                                  onClick={() => setQuotes((q) => ({ ...q, [m.id]: !showQ }))}
                                >
                                  {showQ ? "Hide quoted history" : "Show quoted history"}
                                </button>
                                {showQ && <div className="emc-quoted">{m.quotedText}</div>}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {data.connected && (
                      <div className="emc-reply">
                        <textarea
                          placeholder={`Reply to ${first}…`}
                          value={drafts[t.id] || ""}
                          maxLength={20000}
                          onChange={(e) => setDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                        />
                        <div className="row">
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              const target = replyTarget(t);
                              setCompose({
                                threadId: t.id,
                                reply: target ? { messageId: target.messageId, subject: t.subject } : undefined,
                                initialText: drafts[t.id] || "",
                              });
                            }}
                          >
                            Open in composer
                          </button>
                          <RemindChips
                            compact
                            value={remindFor(t.id)}
                            onChange={(v) => setRemindQ((q) => ({ ...q, [t.id]: v }))}
                            today={todayDay()}
                            disabled={sending === t.id}
                          />
                          <button
                            className="emc-btn"
                            disabled={!(drafts[t.id] || "").trim() || sending === t.id}
                            onClick={() => quickReply(t)}
                          >
                            {sending === t.id ? "SENDING…" : "SEND REPLY →"}
                          </button>
                        </div>
                        {err && sending === null && <p className="em-warn">{err}</p>}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </>
      )}

      {compose && (
        <EmailModal
          key={compose.nonce || "plain"}
          candKey={candKey}
          candidateName={name}
          reply={compose.reply}
          initialText={compose.initialText}
          completeTaskId={completeTaskId || undefined}
          inboxThreadId={compose.threadId || inboxThreadId || undefined}
          initialTemplate={compose.template || undefined}
          initialTemplateName={compose.templateName}
          initialButton={compose.button}
          threadSubject={compose.threadSubject}
          after={compose.after}
          outcome={compose.outcome}
          allowSilent={compose.allowSilent}
          remindMode={compose.remind === false ? "off" : "on"}
          onSilent={onSilent ? () => { setCompose(null); onSilent(); } : undefined}
          onClose={() => setCompose(null)}
          onSent={(result) => {
            // The draft went out through the composer: clear it here so the
            // quick-reply box can't send it a second time.
            const sentFrom = compose.threadId;
            if (sentFrom) setDrafts((d) => ({ ...d, [sentFrom]: "" }));
            load();
            onSent?.(result);
          }}
        />
      )}
    </div>
  );
}
