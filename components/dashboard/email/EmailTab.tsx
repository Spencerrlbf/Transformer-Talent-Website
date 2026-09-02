"use client";
// The drawer's Email tab: this candidate's conversations, chat-style.
// Threads group by the provider's thread id (what's one conversation in
// Outlook/Gmail is one here); each bubble is that message's own words, the
// quoted chain sits behind a toggle. Quick reply sends a true threaded
// reply; "Open in composer" hands the same text to the full composer.
import { useCallback, useEffect, useState } from "react";
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
type Data = { connected: boolean; address: string; awaiting: number; threads: Thread[] };

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
}: {
  candKey: string;
  name: string;
  /** Reports the awaiting-reply count so the tab badge stays current. */
  onAwaiting?: (n: number) => void;
}) {
  const { token } = useDash();
  const first = name.split(/\s+/)[0] || name;

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [compose, setCompose] = useState<null | {
    threadId?: string;
    reply?: { messageId: string; subject: string };
    initialText?: string;
  }>(null);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/dashboard/email/threads?key=${candKey}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Data>;
      })
      .then((d) => {
        setData(d);
        setError(false);
        setOpen((cur) => (cur && d.threads.some((t) => t.id === cur) ? cur : d.threads[0]?.id || null));
        onAwaiting?.(d.awaiting);
      })
      .catch(() => setError(true));
  }, [candKey, token, onAwaiting]);

  useEffect(load, [load]);

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
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (r.ok && j.ok) {
        setDrafts((d) => ({ ...d, [t.id]: "" }));
        load();
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
                  <span className={`emc-chip ${t.awaiting ? "wait" : "done"}`}>
                    {t.awaiting ? "Awaiting your reply" : hasInbound ? "Replied" : "Sent"}
                  </span>
                  <span className="emc-meta">
                    {t.messages.length} message{t.messages.length === 1 ? "" : "s"} · {fmtWhen(t.lastAt)}
                  </span>
                  <span className="emc-caret">{isOpen ? "▾" : "▸"}</span>
                </div>

                {isOpen && (
                  <>
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
                          <span className="hint">Sends as a reply in the same thread, from your inbox</span>
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
          candKey={candKey}
          candidateName={name}
          reply={compose.reply}
          initialText={compose.initialText}
          onClose={() => setCompose(null)}
          onSent={() => {
            // The draft went out through the composer: clear it here so the
            // quick-reply box can't send it a second time.
            const sentFrom = compose.threadId;
            if (sentFrom) setDrafts((d) => ({ ...d, [sentFrom]: "" }));
            load();
          }}
        />
      )}
    </div>
  );
}
