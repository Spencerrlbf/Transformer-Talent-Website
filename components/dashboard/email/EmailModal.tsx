"use client";
// Send-as-you compose modal + org template manager. One modal opened from
// the candidate drawer / Notes tab; the seat's first visit shows the
// connect gate instead of the composer. Merge fields resolve at insert
// time (the body always shows exactly what will send); an empty value
// becomes an atomic red pill that blocks Send until dealt with.
import { useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type ComposeJob = {
  id: string;
  title: string;
  company: string;
  salary: string;
  locations: string[];
  workplace: string;
  url: string;
};
type Template = { id: string; name: string; subject: string; bodyHtml: string };
type Ctx = {
  connected: boolean;
  address: string;
  candidate: { name: string; email: string | null };
  senderName: string;
  jobs: ComposeJob[];
  templates: Template[];
  trackedLink: string;
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Pills and merged role values carry data-mf so a Merge-role change can
// re-resolve them in place (the server sanitizer strips the attribute, so
// nothing leaks into the sent email).
const missPill = (label: string, mf?: string) =>
  `<span class="em-miss"${mf ? ` data-mf="${mf}"` : ""} contenteditable="false">${esc(label)}</span>`;

const shortUrl = (u: string) => u.replace(/^https?:\/\//, "");

// Candidate-facing meta joins on "·" (the copy rules ban em-dashes in
// anything a candidate reads).
function jobBlockHtml(j: ComposeJob): string {
  const meta = [j.salary, j.locations.slice(0, 3).join(", "), j.workplace]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  const title = j.url
    ? `<a href="${esc(j.url)}">${esc(j.title)}</a>`
    : esc(j.title);
  return `<div><b>${title}</b>${meta ? ` · ${meta}` : ""}</div><div><br></div>`;
}

// Same allowlist as the server's sanitizeEmailHtml, applied to pasted HTML
// so the preview always matches what actually sends.
const OK_TAGS = new Set(["b", "strong", "i", "em", "u", "p", "div", "span", "br", "ul", "ol", "li"]);

function sanitizePastedHtml(html: string): string {
  return html.slice(0, 100_000).replace(/<[^>]*>?/g, (tag) => {
    if (!tag.endsWith(">")) return "";
    const m = /^<\s*(\/?)\s*([a-zA-Z0-9]+)/.exec(tag);
    if (!m) return "";
    const close = m[1] === "/";
    const name = m[2].toLowerCase();
    if (name === "a") {
      if (close) return "</a>";
      const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const url = (href?.[1] ?? href?.[2] ?? "").trim();
      if (/^(https?:|mailto:)/i.test(url)) return `<a href="${url.replace(/"/g, "&quot;")}">`;
      return "<a>";
    }
    if (OK_TAGS.has(name)) return close ? `</${name}>` : name === "br" ? "<br>" : `<${name}>`;
    return "";
  });
}

function handleEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
  e.preventDefault();
  const html = e.clipboardData.getData("text/html");
  if (html) document.execCommand("insertHTML", false, sanitizePastedHtml(html));
  else document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
}

// ---------------------------------------------------------------- compose

export default function EmailModal({
  candKey,
  candidateName,
  onClose,
  onSent,
}: {
  candKey: string;
  candidateName: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const { token } = useDash();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [ctxErr, setCtxErr] = useState(false);
  const [reconnect, setReconnect] = useState(false);

  const [subject, setSubject] = useState("");
  const [roleId, setRoleId] = useState("");
  const [misses, setMisses] = useState(0);
  const [hasBody, setHasBody] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [connecting, setConnecting] = useState(false);

  const [menu, setMenu] = useState<"" | "tpl" | "fields" | "job" | "link" | "joblink">("");
  const [jobQ, setJobQ] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [manage, setManage] = useState<"" | "list" | "new">("");
  const [pendingTpl, setPendingTpl] = useState("");
  const [gateErr, setGateErr] = useState("");

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  const prevRole = useRef<{ title: string; company: string } | null>(null);
  const first = candidateName.split(/\s+/)[0] || candidateName;

  const loadCtx = useCallback(() => {
    fetch("/api/dashboard/email/context", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ candidateKey: candKey }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Ctx>;
      })
      .then((c) => {
        setCtx(c);
        setRoleId((cur) => cur || c.jobs[0]?.id || "");
      })
      .catch(() => setCtxErr(true));
  }, [candKey, token]);

  useEffect(loadCtx, [loadCtx]);

  // Above the drawer: swallow Escape before the drawer's document handler.
  // Deps include the open sublayers so this handler re-registers behind
  // theirs and each Escape peels one layer.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (menu) setMenu("");
        else onClose();
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [onClose, menu, manage]);

  // Changing the Role-for-fields select re-resolves everything that was
  // merged from the old role: data-mf spans in the body swap value<->pill,
  // and the subject swaps the old role's strings for the new one's.
  useEffect(() => {
    if (!ctx) return;
    const role = ctx.jobs.find((j) => j.id === roleId);
    const next = { title: role?.title || "", company: role?.company || "" };
    const prev = prevRole.current;
    prevRole.current = next;
    if (!prev || (prev.title === next.title && prev.company === next.company)) return;

    const el = bodyRef.current;
    if (el) {
      el.querySelectorAll<HTMLElement>("[data-mf]").forEach((span) => {
        const key = span.getAttribute("data-mf");
        if (key !== "job_title" && key !== "company") return;
        const val = key === "job_title" ? next.title : next.company;
        if (val) {
          span.textContent = val;
          span.className = "";
          span.removeAttribute("contenteditable");
        } else {
          span.textContent = key === "job_title" ? "role title" : "company";
          span.className = "em-miss";
          span.setAttribute("contenteditable", "false");
        }
      });
      setMisses(el.querySelectorAll(".em-miss").length);
      setHasBody((el.innerText || "").trim().length > 0);
    }
    setSubject((s) => {
      let out = s;
      if (prev.title && next.title) out = out.split(prev.title).join(next.title);
      if (prev.company && next.company) out = out.split(prev.company).join(next.company);
      return out.slice(0, 300);
    });
  }, [ctx, roleId]);

  // Any open floater (Insert {}, Insert job, the link row) dismisses on a
  // press anywhere else. Capture-phase pointerdown: fires before anything
  // can swallow the event, and covers mouse + touch alike.
  useEffect(() => {
    if (!menu) return;
    const h = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(".em-menuwrap") && !t.closest(".em-linkwrap")) setMenu("");
    };
    document.addEventListener("pointerdown", h, true);
    return () => document.removeEventListener("pointerdown", h, true);
  }, [menu]);

  // ---- editor helpers ----

  const refreshFlags = () => {
    const el = bodyRef.current;
    if (!el) return;
    setMisses(el.querySelectorAll(".em-miss").length);
    setHasBody((el.innerText || "").trim().length > 0);
  };

  const focusBody = () => bodyRef.current?.focus();

  /** Keep the caret position across focus loss — opening a menu or typing
   *  in the job search steals it, and inserts must land where the user
   *  last was, not at the top of the email. */
  const rememberSel = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && bodyRef.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange();
    }
  };

  const insertHtml = (html: string) => {
    const el = bodyRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      if (savedRange.current && el.contains(savedRange.current.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(savedRange.current);
      } else if (!el.contains(sel.anchorNode)) {
        // Never touched the editor: append at the end, not the start.
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    document.execCommand("insertHTML", false, html);
    rememberSel();
    refreshFlags();
  };

  const cmd = (c: string) => {
    focusBody();
    document.execCommand(c);
  };

  const mergeValues = useCallback((): Record<string, { value: string; label: string; html?: string }> => {
    const c = ctx!;
    const role = c.jobs.find((j) => j.id === roleId);
    return {
      first_name: { value: first, label: "first name" },
      full_name: { value: candidateName, label: "full name" },
      job_title: { value: role?.title || "", label: "role title" },
      company: { value: role?.company || "", label: "company" },
      tracked_link: {
        value: c.trackedLink,
        label: "tracked link",
        html: c.trackedLink
          ? `<a href="${esc(c.trackedLink)}">${esc(shortUrl(c.trackedLink))}</a>`
          : undefined,
      },
      sender_name: { value: c.senderName, label: "your name" },
    };
  }, [ctx, roleId, first, candidateName]);

  // Role-dependent fields render as data-mf spans (value or pill) so they
  // stay live-bound to the Role-for-fields select.
  const fieldHtml = (key: string, f: { value: string; label: string; html?: string }): string => {
    const isRole = key === "job_title" || key === "company";
    if (!f.value) return missPill(f.label, isRole ? key : undefined);
    if (isRole) return `<span data-mf="${key}">${esc(f.value)}</span>`;
    return f.html || esc(f.value);
  };

  const resolveHtml = (tpl: string): string => {
    const vals = mergeValues();
    return tpl
      .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, raw: string) => {
        const f = vals[raw.toLowerCase()];
        if (!f) return missPill(raw.replace(/_/g, " "));
        return fieldHtml(raw.toLowerCase(), f);
      })
      // Malformed tokens ({{first-name}}, {{link 2}}, …) become pills too,
      // so nothing token-shaped ever survives unhighlighted.
      .replace(/\{\{[^}]*\}\}/g, (m) => missPill(m.replace(/[{}]/g, "").trim() || "field"));
  };

  const resolveSubject = (tpl: string): string => {
    const vals = mergeValues();
    return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, raw: string) => {
      const f = vals[raw.toLowerCase()];
      return f && f.value ? f.value : m;
    });
  };

  // Two-click confirm (the house pattern — no native dialogs): first click
  // on a chip while a draft exists flips it to "Replace draft?".
  const applyTemplate = (t: Template) => {
    const el = bodyRef.current;
    if (!el) return;
    if ((el.innerText || "").trim() && pendingTpl !== t.id) {
      setPendingTpl(t.id);
      return;
    }
    setPendingTpl("");
    setMenu("");
    setSubject(resolveSubject(t.subject).slice(0, 300));
    el.innerHTML = resolveHtml(t.bodyHtml);
    refreshFlags();
  };

  const insertField = (key: string) => {
    const vals = mergeValues();
    const f = vals[key];
    if (!f) return;
    setMenu("");
    insertHtml(fieldHtml(key, f));
  };

  const openLink = () => {
    const sel = window.getSelection();
    savedRange.current =
      sel && sel.rangeCount > 0 && bodyRef.current?.contains(sel.anchorNode)
        ? sel.getRangeAt(0).cloneRange()
        : null;
    setLinkUrl("");
    setMenu(menu === "link" ? "" : "link");
  };

  /** Link the saved selection to a URL (typed, a job's JD, or the tracked
   *  link); with no selection, insert linked text instead. */
  const applyLink = (urlArg?: string, label?: string) => {
    let url = (urlArg ?? linkUrl).trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    focusBody();
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    if (sel && !sel.isCollapsed) {
      document.execCommand("createLink", false, url);
    } else {
      document.execCommand(
        "insertHTML",
        false,
        `<a href="${esc(url)}">${esc(label || shortUrl(url))}</a>`
      );
    }
    setMenu("");
    refreshFlags();
  };

  // ---- actions ----

  const connect = async () => {
    setConnecting(true);
    setGateErr("");
    try {
      const r = await fetch("/api/dashboard/email/connect", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await r.json()) as { url?: string };
      if (j.url) {
        window.location.href = j.url;
        return;
      }
    } catch {
      /* fall through */
    }
    setGateErr("Couldn't start the connect flow. Try again in a moment.");
    setConnecting(false);
  };

  const send = async () => {
    const el = bodyRef.current;
    if (!el || sending) return;
    setErr("");
    if (subject.includes("{{")) {
      setErr("The subject still has an unfilled field — edit it before sending.");
      return;
    }
    if ((el.innerText || "").includes("{{")) {
      setErr("There's an unfilled {{…}} placeholder in the message — replace or remove it.");
      return;
    }
    setSending(true);
    try {
      const r = await fetch("/api/dashboard/email/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ candidateKey: candKey, subject: subject.trim(), html: el.innerHTML }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (r.ok && j.ok) {
        onSent();
        onClose();
        return;
      }
      if (j.error === "not_connected" || j.error === "grant_invalid") {
        setReconnect(true);
        setCtx((c) => (c ? { ...c, connected: false } : c));
      } else if (j.error === "unresolved_fields") {
        setErr("Some fields are still unfilled — replace or remove the {{…}} placeholders and red pills.");
      } else if (j.error === "bad_subject") {
        setErr("The subject is too long after filling fields — shorten it (300 characters max).");
      } else if (j.error === "no_candidate_email") {
        setErr(`No email on file for ${first} — add one in the contact section first.`);
      } else {
        setErr("Sending failed — nothing went out. Try again in a moment.");
      }
    } catch {
      setErr("Network error — nothing went out. Try again.");
    }
    setSending(false);
  };

  // ---- render ----

  const filteredJobs =
    ctx?.jobs.filter((j) => {
      const q = jobQ.trim().toLowerCase();
      if (!q) return true;
      return (
        j.title.toLowerCase().includes(q) ||
        j.company.toLowerCase().includes(q) ||
        `#${j.id}`.includes(q)
      );
    }) || [];

  const blocked =
    sending || !subject.trim() || !hasBody || misses > 0 || !ctx?.candidate.email;

  return (
    <>
      {/* stopPropagation: from the drawer header this modal sits inside the
          drawer's own overlay — a backdrop click must not fall through and
          close the drawer too. */}
      <div
        className="tkm-back"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="tkm em-tkm" onClick={(e) => e.stopPropagation()}>
          {ctxErr && (
            <>
              <h3>Email {first}</h3>
              <p className="tkm-sub">Couldn&apos;t load the composer — close and try again.</p>
            </>
          )}
          {!ctx && !ctxErr && (
            <>
              <h3>Email {first}</h3>
              <p className="tkm-sub">Loading…</p>
            </>
          )}

          {ctx && !ctx.connected && (
            <>
              <h3>Send email as you</h3>
              <p className="tkm-sub">
                {reconnect
                  ? "Your email connection expired or was revoked — reconnect to keep sending."
                  : "Connect your own inbox once — emails go out from your address and replies land back in it."}
              </p>
              <button className="em-provbtn" onClick={connect} disabled={connecting}>
                {connecting ? "OPENING…" : "CONNECT YOUR EMAIL →"}
              </button>
              {gateErr && <p className="em-warn">{gateErr}</p>}
              <p className="em-fine">
                Google and Microsoft accounts are supported — you&apos;ll approve access in your
                provider&apos;s own window, and you can disconnect at any time. Transformer Talent
                only stores email to and from your candidates, never the rest of your inbox.
              </p>
              <div className="tkm-foot">
                <button className="tkm-cancel" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {ctx && ctx.connected && (
            <>
              <h3>Email {first}</h3>
              <p className="tkm-sub">
                From <b>{ctx.address}</b> · sent from your own inbox, logged to the timeline
              </p>

              <span className="lbl em-lblfirst">To</span>
              {ctx.candidate.email ? (
                <span className="em-pill">
                  {ctx.candidate.name || "Candidate"} <i>&lt;{ctx.candidate.email}&gt;</i>
                </span>
              ) : (
                <p className="em-warn">
                  No email on file for {first} — add one in the drawer&apos;s contact section first.
                </p>
              )}

              <div
                className="cv2n-duo"
                style={{ gridTemplateColumns: ctx.jobs.length ? "1.6fr 1fr" : "1fr" }}
              >
                <label style={{ display: "contents" }}>
                  <span>
                    <span className="lbl em-lbl0">Subject</span>
                    <input
                      className="em-subject"
                      value={subject}
                      maxLength={300}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder={`e.g. A role that fits your background, ${first}`}
                    />
                  </span>
                </label>
                {ctx.jobs.length > 0 && (
                  <span>
                    <span className="lbl em-lbl0">Role for fields</span>
                    <select
                      className="em-roleselect"
                      value={roleId}
                      onChange={(e) => setRoleId(e.target.value)}
                    >
                      {ctx.jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.title}
                          {j.company ? ` · ${j.company}` : ""}
                        </option>
                      ))}
                    </select>
                  </span>
                )}
              </div>

              <span className="lbl">Message</span>
              <div className="em-editor">
                <div className="em-toolbar">
                  <button type="button" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("bold")}>
                    <b>B</b>
                  </button>
                  <button type="button" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("italic")}>
                    <i>I</i>
                  </button>
                  <button type="button" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("underline")}>
                    <u>U</u>
                  </button>
                  <button type="button" title="Link" onMouseDown={(e) => e.preventDefault()} onClick={openLink}>
                    🔗
                  </button>
                  <button
                    type="button"
                    title="Bulleted list"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => cmd("insertUnorderedList")}
                  >
                    ≔
                  </button>
                  <button
                    type="button"
                    title="Numbered list"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => cmd("insertOrderedList")}
                  >
                    1.
                  </button>
                  <span className="em-tbsep" />
                  <div className="em-menuwrap">
                    <button
                      type="button"
                      className="em-word"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setPendingTpl("");
                        setMenu(menu === "tpl" ? "" : "tpl");
                      }}
                    >
                      Template
                    </button>
                    {menu === "tpl" && (
                      <div className="em-menu em-tplmenu">
                        {ctx.templates.length === 0 && <p className="em-fine">No templates yet.</p>}
                        {ctx.templates.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={pendingTpl === t.id ? "em-tplpending" : undefined}
                            onClick={() => applyTemplate(t)}
                          >
                            {pendingTpl === t.id ? "Replace draft?" : t.name}
                            {pendingTpl !== t.id && !!t.subject && <small>{t.subject}</small>}
                          </button>
                        ))}
                        <div className="em-menudiv" />
                        <button
                          type="button"
                          className="em-menuact"
                          onClick={() => {
                            setMenu("");
                            setManage("new");
                          }}
                        >
                          ＋ New template…
                        </button>
                        <button
                          type="button"
                          className="em-menuact"
                          onClick={() => {
                            setMenu("");
                            setManage("list");
                          }}
                        >
                          Manage templates
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="em-menuwrap">
                    <button
                      type="button"
                      className="em-word"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setMenu(menu === "fields" ? "" : "fields")}
                    >
                      Insert {"{}"}
                    </button>
                    {menu === "fields" && (
                      <div className="em-menu">
                        {[
                          ["first_name", "First name"],
                          ["full_name", "Full name"],
                          ["job_title", "Role title"],
                          ["company", "Company"],
                          ["tracked_link", "Tracked link"],
                          ["sender_name", "Your name"],
                        ].map(([k, label]) => (
                          <button
                            key={k}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => insertField(k)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="em-menuwrap">
                    <button
                      type="button"
                      className="em-word"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setJobQ("");
                        setMenu(menu === "job" ? "" : "job");
                      }}
                      disabled={!ctx.jobs.length}
                      title={ctx.jobs.length ? "Insert a job line" : "No open jobs"}
                    >
                      Insert job
                    </button>
                    {menu === "job" && (
                      <div className="em-menu em-jobmenu">
                        <input
                          className="em-jobsearch"
                          placeholder="Search jobs…"
                          value={jobQ}
                          autoFocus
                          onChange={(e) => setJobQ(e.target.value)}
                        />
                        <div className="em-jobscroll">
                          {filteredJobs.map((j) => (
                            <button
                              key={j.id}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => {
                                setMenu("");
                                insertHtml(jobBlockHtml(j));
                              }}
                            >
                              {j.title}
                              <small>
                                {[j.company, j.salary, j.workplace].filter(Boolean).join(" · ")}
                              </small>
                            </button>
                          ))}
                          {!filteredJobs.length && <p className="em-fine">No matches.</p>}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {(menu === "link" || menu === "joblink") && (
                  <div className="em-linkwrap">
                    <div className="em-linkrow">
                      <input
                        placeholder="https://…"
                        value={linkUrl}
                        autoFocus={menu === "link"}
                        onChange={(e) => setLinkUrl(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            applyLink();
                          }
                        }}
                      />
                      <button type="button" className="tk-doneb" onClick={() => applyLink()}>
                        Add link
                      </button>
                      {ctx.jobs.length > 0 && (
                        <button
                          type="button"
                          className="tk-doneb"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setJobQ("");
                            setMenu(menu === "joblink" ? "link" : "joblink");
                          }}
                        >
                          Job link…
                        </button>
                      )}
                      {ctx.trackedLink && (
                        <button
                          type="button"
                          className="tk-doneb"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => setLinkUrl(ctx.trackedLink)}
                        >
                          Tracked link
                        </button>
                      )}
                    </div>
                    {menu === "joblink" && (
                      <div className="em-menu em-jobmenu">
                        <input
                          className="em-jobsearch"
                          placeholder="Link to which job…"
                          value={jobQ}
                          autoFocus
                          onChange={(e) => setJobQ(e.target.value)}
                        />
                        <div className="em-jobscroll">
                          {filteredJobs
                            .filter((j) => j.url)
                            .map((j) => (
                              <button
                                key={j.id}
                                type="button"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  // Populate the URL field (same flow as
                                  // Tracked link); Add link applies it.
                                  setLinkUrl(j.url);
                                  setMenu("link");
                                }}
                              >
                                {j.title}
                                <small>
                                  {[j.company, j.salary, j.workplace].filter(Boolean).join(" · ")}
                                </small>
                              </button>
                            ))}
                          {!filteredJobs.filter((j) => j.url).length && (
                            <p className="em-fine">No matches.</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div
                  className="em-body"
                  ref={bodyRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={() => {
                    rememberSel();
                    refreshFlags();
                  }}
                  onKeyUp={rememberSel}
                  onMouseUp={rememberSel}
                  onPaste={(e) => {
                    handleEditorPaste(e);
                    rememberSel();
                    refreshFlags();
                  }}
                />
              </div>
              {misses > 0 && (
                <p className="em-warn">
                  {misses} field{misses > 1 ? "s" : ""} came up empty for {first} — replace the
                  highlighted pill{misses > 1 ? "s" : ""} with real text (or delete{" "}
                  {misses > 1 ? "them" : "it"}).
                </p>
              )}
              {err && <p className="em-warn">{err}</p>}

              <div className="tkm-foot">
                <span className="em-foothint">Logged to {first}&apos;s timeline on send</span>
                <button className="tkm-cancel" onClick={onClose} disabled={sending}>
                  Cancel
                </button>
                <button className="tkm-save" onClick={send} disabled={blocked}>
                  {sending ? "SENDING…" : "SEND EMAIL →"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {manage && (
        <TemplatesModal
          startNew={manage === "new"}
          onClose={() => setManage("")}
          onChanged={loadCtx}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------- templates

export function TemplatesModal({
  startNew = false,
  onClose,
  onChanged,
}: {
  /** Open straight into the new-template editor (toolbar "＋ New template…"). */
  startNew?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { token } = useDash();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [editing, setEditing] = useState<"" | "new" | string>("");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    fetch("/api/dashboard/email/templates", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json() as Promise<{ templates: Template[] }>)
      .then((j) => setTemplates(j.templates || []))
      .catch(() => setTemplates([]));
  }, [token]);
  useEffect(load, [load]);

  useEffect(() => {
    if (startNew) startEdit(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [onClose]);

  const startEdit = (t: Template | null) => {
    setErr("");
    setConfirmDel("");
    setEditing(t ? t.id : "new");
    setName(t?.name || "");
    setSubject(t?.subject || "");
    // The editor div mounts on this render; seed it just after.
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.innerHTML = t?.bodyHtml || "";
    });
  };

  const insertToken = (tok: string) => {
    bodyRef.current?.focus();
    document.execCommand("insertText", false, `{{${tok}}}`);
  };

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setErr("");
    const payload = {
      name: name.trim(),
      subject,
      bodyHtml: bodyRef.current?.innerHTML || "",
    };
    const isNew = editing === "new";
    try {
      const r = await fetch(
        isNew ? "/api/dashboard/email/templates" : `/api/dashboard/email/templates/${editing}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (r.ok && j.ok) {
        setEditing("");
        load();
        onChanged();
      } else {
        setErr(j.error === "duplicate_name" ? "A template with that name already exists." : "Couldn't save — try again.");
      }
    } catch {
      setErr("Network error — try again.");
    }
    setBusy(false);
  };

  const del = async (id: string) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      return;
    }
    setBusy(true);
    await fetch(`/api/dashboard/email/templates/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
    setBusy(false);
    setConfirmDel("");
    if (editing === id) setEditing("");
    load();
    onChanged();
  };

  return (
    <div
      className="tkm-back"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="tkm em-tkm" onClick={(e) => e.stopPropagation()}>
        <h3>Email templates</h3>
        <p className="tkm-sub">
          Shared with your whole team. Fields like {"{{first_name}}"} fill in per candidate when a
          template is used.
        </p>

        {!templates && <p className="em-fine">Loading…</p>}
        {templates?.map((t) =>
          editing === t.id ? (
            <TemplateEditor
              key={t.id}
              name={name}
              subject={subject}
              setName={setName}
              setSubject={setSubject}
              bodyRef={bodyRef}
              insertToken={insertToken}
              busy={busy}
              err={err}
              onCancel={() => setEditing("")}
              onSave={save}
              onDelete={() => del(t.id)}
              confirmDel={confirmDel === t.id}
            />
          ) : (
            <div className="emt-row" key={t.id}>
              <span className="emt-name">{t.name}</span>
              <span className="emt-subj">{t.subject}</span>
              <button className="cv2n-edit" onClick={() => startEdit(t)}>
                Edit
              </button>
            </div>
          )
        )}
        {templates && templates.length === 0 && editing !== "new" && (
          <p className="em-fine">No templates yet — create your first one.</p>
        )}

        {editing === "new" ? (
          <TemplateEditor
            name={name}
            subject={subject}
            setName={setName}
            setSubject={setSubject}
            bodyRef={bodyRef}
            insertToken={insertToken}
            busy={busy}
            err={err}
            onCancel={() => setEditing("")}
            onSave={save}
          />
        ) : (
          <button className="emt-new" onClick={() => startEdit(null)}>
            ＋ New template…
          </button>
        )}

        <div className="tkm-foot">
          <button className="tkm-cancel" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateEditor({
  name,
  subject,
  setName,
  setSubject,
  bodyRef,
  insertToken,
  busy,
  err,
  onCancel,
  onSave,
  onDelete,
  confirmDel,
}: {
  name: string;
  subject: string;
  setName: (v: string) => void;
  setSubject: (v: string) => void;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  insertToken: (t: string) => void;
  busy: boolean;
  err: string;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
  confirmDel?: boolean;
}) {
  return (
    <div className="emt-editbox">
      <span className="lbl em-lbl0">Name</span>
      <input className="em-subject" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      <span className="lbl">Subject</span>
      <input
        className="em-subject"
        value={subject}
        maxLength={300}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="{{job_title}} role worth a look, {{first_name}}"
      />
      <span className="lbl">Body</span>
      <div className="em-editor">
        <div className="em-toolbar">
          <button type="button" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => { bodyRef.current?.focus(); document.execCommand("bold"); }}>
            <b>B</b>
          </button>
          <button type="button" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => { bodyRef.current?.focus(); document.execCommand("italic"); }}>
            <i>I</i>
          </button>
          <button type="button" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => { bodyRef.current?.focus(); document.execCommand("underline"); }}>
            <u>U</u>
          </button>
          <span className="em-tbsep" />
          {["first_name", "full_name", "job_title", "company", "tracked_link", "sender_name"].map((t) => (
            <button key={t} type="button" className="em-word" onMouseDown={(e) => e.preventDefault()} onClick={() => insertToken(t)}>
              {t}
            </button>
          ))}
        </div>
        <div
          className="em-body em-tplbody"
          ref={bodyRef}
          contentEditable
          suppressContentEditableWarning
          onPaste={handleEditorPaste}
        />
      </div>
      {err && <p className="em-warn">{err}</p>}
      <div className="tkm-foot">
        {onDelete && (
          <button className="tkm-del" onClick={onDelete} disabled={busy}>
            {confirmDel ? "Really delete?" : "Delete"}
          </button>
        )}
        <button className="tkm-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="tkm-save" onClick={onSave} disabled={busy || !name.trim()}>
          {busy ? "SAVING…" : "SAVE"}
        </button>
      </div>
    </div>
  );
}
