"use client";
// Settings → Email templates: the wording the whole team sends. Which button
// uses which template is fixed in the code, so there is nothing to configure;
// this is the list, the editor and a preview. Restore is the owner's.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";
import { TemplateEditor } from "@/components/dashboard/email/EmailModal";
import PersonPicker from "@/components/dashboard/home/PersonPicker";
import { QUICK_BUTTONS, type QuickButton } from "@/lib/quick-buttons";
import { htmlToLines, mergeText, previewValues, type PreviewCtx } from "@/lib/email-preview";
import type { Template } from "@/lib/server/email-compose";

type Data = { templates: Template[]; canRestore: boolean };

const who = (email?: string) => {
  const local = (email || "").split("@")[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
};
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

export default function TemplatesPage() {
  const { token } = useDash();
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [notice, setNotice] = useState("");
  const [mapBusy, setMapBusy] = useState("");
  // Preview: a real person, merged the way Send merges.
  const [picker, setPicker] = useState(false);
  const [person, setPerson] = useState<{ key: string; name: string } | null>(null);
  const [pctx, setPctx] = useState<PreviewCtx | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(
    () =>
      fetch("/api/dashboard/email/templates", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json() as Promise<Data>;
        })
        .then((d) => {
          setData(d);
          setError(false);
          return d;
        })
        .catch(() => {
          setError(true);
          return null;
        }),
    [token]
  );

  const startEdit = useCallback((t: Template | null) => {
    setErr("");
    setConfirmDel(false);
    setSelected(t ? t.id : "new");
    setName(t?.name || "");
    setSubject(t?.subject || "");
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.innerHTML = t?.bodyHtml || "";
      setTick((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    load().then((d) => {
      if (d && d.templates[0] && !selected) startEdit(d.templates.find((t) => t.actionKey) || d.templates[0]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // The preview follows the editor as you type.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const h = () => setTick((n) => n + 1);
    el.addEventListener("input", h);
    return () => el.removeEventListener("input", h);
  }, [selected]);

  useEffect(() => {
    if (!person) return;
    setPctx(null);
    fetch("/api/dashboard/email/context", { method: "POST", headers: auth, body: JSON.stringify({ candidateKey: person.key }) })
      .then(async (r) => (r.ok ? (r.json() as Promise<PreviewCtx>) : null))
      .then((c) => setPctx(c))
      .catch(() => setPctx(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person]);

  const insertToken = (tok: string) => {
    bodyRef.current?.focus();
    document.execCommand("insertText", false, `{{${tok}}}`);
    setTick((n) => n + 1);
  };

  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setErr("");
    const isNew = selected === "new";
    const r = await fetch(isNew ? "/api/dashboard/email/templates" : `/api/dashboard/email/templates/${selected}`, {
      method: isNew ? "POST" : "PATCH",
      headers: auth,
      body: JSON.stringify({ name: name.trim(), subject, bodyHtml: bodyRef.current?.innerHTML || "" }),
    }).catch(() => null);
    const j = ((await r?.json().catch(() => ({}))) || {}) as { ok?: boolean; error?: string; template?: Template };
    setBusy(false);
    if (r?.ok && j.ok) {
      const d = await load();
      const next = isNew && j.template ? d?.templates.find((t) => t.id === j.template!.id) || null : d?.templates.find((t) => t.id === selected) || null;
      if (next) startEdit(next);
      setNotice("Saved.");
      window.setTimeout(() => setNotice(""), 1500);
    } else {
      setErr(j.error === "duplicate_name" ? "A template with that name already exists." : "Couldn't save. Try again.");
    }
  };

  const del = async () => {
    if (!confirmDel) {
      setConfirmDel(true);
      return;
    }
    setBusy(true);
    await fetch(`/api/dashboard/email/templates/${selected}`, { method: "DELETE", headers: auth }).catch(() => null);
    setBusy(false);
    setConfirmDel(false);
    const d = await load();
    startEdit(d?.templates[0] || null);
  };

  const post = async (body: Record<string, unknown>, key: string) => {
    setMapBusy(key);
    const r = await fetch("/api/dashboard/email/templates/buttons", { method: "POST", headers: auth, body: JSON.stringify(body) }).catch(() => null);
    setMapBusy("");
    if (!r?.ok) setNotice("Couldn't change that. Nothing changed; try again.");
    else setNotice("");
    await load();
  };

  const templates = data?.templates || [];
  const byId = new Map(templates.map((t) => [t.id, t]));
  const keys = new Set(templates.map((t) => t.actionKey).filter(Boolean));
  // Which buttons send a template is fixed in the code: a button uses the
  // org's copy of its stock wording, found by action key.
  const usedBy = (t: Template | null) => (t?.actionKey ? QUICK_BUTTONS.filter((b) => b.defaultKey === t.actionKey) : []);
  const current = selected && selected !== "new" ? byId.get(selected) || null : null;
  const stock = templates.filter((t) => t.actionKey);
  const own = templates.filter((t) => !t.actionKey);
  const missing = QUICK_BUTTONS.filter((b) => !keys.has(b.defaultKey));

  // Preview text from what is in the editor right now.
  const values = pctx ? previewValues(pctx, "(the thread's subject)") : null;
  const previewSubject = values ? mergeText(subject, values) : "";
  const previewBody = values ? mergeText(htmlToLines(bodyRef.current?.innerHTML || ""), values) : "";
  void tick;

  return (
    <>
      <div className="tk-head tp-head">
        <div>
          <h1 className="dash-h1">Email templates</h1>
          <p className="dash-sub">
            The wording your team sends, shared by everyone. Pressing a button in the Inbox or on Home opens the composer with its wording already merged for that person, and you can swap to any
            other template from the composer before you send. The chip under each name says which button uses it. There is nothing to configure here.{" "}
            <Link href="/dashboard/settings">Back to Settings</Link>
          </p>
        </div>
        <button type="button" className="dash-btn" onClick={() => startEdit(null)}>
          + New template
        </button>
      </div>

      {error && <p className="cv2d-err">Couldn&apos;t load the templates. Refresh to try again.</p>}
      {notice && <p className={notice === "Saved." ? "dash-saved" : "cv2d-err"}>{notice}</p>}

      <div className="tp-panes">
        <div className="tp-card">
          <div className="ch">
            <div>
              <h4>Templates</h4>
              <p className="cs">{data ? `${templates.length} · click one to edit its wording` : "Loading…"}</p>
            </div>
          </div>
          <ul className="tp-list">
            {stock.length > 0 && <li className="grp" style={{ cursor: "default" }}>Default wording</li>}
            {stock.map((t) => (
              <TemplateRow key={t.id} t={t} on={selected === t.id} used={usedBy(t)} onPick={() => startEdit(t)} />
            ))}
            {own.length > 0 && <li className="grp" style={{ cursor: "default" }}>Your own</li>}
            {own.map((t) => (
              <TemplateRow key={t.id} t={t} on={selected === t.id} used={usedBy(t)} onPick={() => startEdit(t)} />
            ))}
            {selected === "new" && (
              <li className="on">
                <b>New template</b>
                <span className="sub">not saved yet</span>
              </li>
            )}
          </ul>
        </div>

        <div className="tp-card">
          {selected ? (
            <>
              <div className="ch">
                <div>
                  <h4>{current ? current.name : "New template"}</h4>
                  <p className="cs">
                    {current
                      ? [
                          current.updatedAt ? `Edited ${when(current.updatedAt)}${who(current.createdBy) ? ` by ${who(current.createdBy)}` : ""}` : null,
                          `used by ${usedBy(current).length} button${usedBy(current).length === 1 ? "" : "s"}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "Give it a name, a subject and the message. It appears in every composer's Template menu."}
                  </p>
                </div>
                {current && <span className={`hm-chip ${current.actionKey ? "acc" : "neu"}`}>{current.actionKey ? "Default wording" : "Your own"}</span>}
              </div>
              <div className="tp-editor">
                <TemplateEditor
                  name={name}
                  subject={subject}
                  setName={setName}
                  setSubject={(v) => {
                    setSubject(v);
                    setTick((n) => n + 1);
                  }}
                  bodyRef={bodyRef}
                  insertToken={insertToken}
                  busy={busy}
                  err={err}
                  onCancel={() => (current ? startEdit(current) : startEdit(templates[0] || null))}
                  onSave={save}
                  onDelete={current ? del : undefined}
                  confirmDel={confirmDel}
                />
                {current && (
                  <p className="tp-fine" style={{ marginTop: 8 }}>
                    {usedBy(current).length > 0 ? (
                      <>
                        <b>Sent when</b> {usedBy(current).map((b) => b.sentence).join(", or when ")}. Changes apply the next time it is pressed.
                      </>
                    ) : (
                      <>
                        <b>No button sends this one.</b> It is there to pick by hand from the composer&apos;s Template dropdown, on any email.
                      </>
                    )}
                  </p>
                )}
                <div className="tp-preview">
                  <div className="ph">
                    Preview as{" "}
                    {person ? <b>{person.name}</b> : <span>nobody yet</span>}
                    <button type="button" className="hm-lnk" onClick={() => setPicker(true)}>
                      {person ? "Change" : "Pick a person"}
                    </button>
                    <span>· merged the way Send would merge it</span>
                  </div>
                  {!person && <p className="pb">Pick a real person to see the subject and message with their details filled in.</p>}
                  {person && !pctx && <p className="pb">Loading…</p>}
                  {person && pctx && (
                    <>
                      <div className="subj">{previewSubject || "(no subject)"}</div>
                      <p className="pb">{previewBody || "(empty message)"}</p>
                    </>
                  )}
                </div>
              </div>
            </>
          ) : (
            <p className="tp-empty">{data ? "No templates yet. Add one, or restore the default wording below." : "Loading…"}</p>
          )}
        </div>
      </div>

      {missing.length > 0 && (
        <div className="tp-card tp-missing">
          <p>
            <b>{missing.length} button{missing.length === 1 ? " has" : "s have"} no wording.</b>{" "}
            {missing.map((b) => `${b.short} · ${b.label}`).join(", ")}. The stock template was deleted, so the composer opens empty when it is pressed.
          </p>
          {data?.canRestore && (
            <button type="button" className="dash-btn dash-btn-2" disabled={mapBusy === "all"} onClick={() => post({ restoreAll: true }, "all")}>
              {mapBusy === "all" ? "Restoring…" : "Restore the missing wording"}
            </button>
          )}
        </div>
      )}

      <p className="tp-fine">
        Every button fills the person&apos;s name, your name, your booking link, your page link and a tracked link. A button that names a role also fills the job title, company and role link, and an application fills the roles they applied for. Drops, referrals and follow-ups fill matched roles; referrals fill the referrer; asks fill the month; replies fill the subject. A field a button cannot fill shows as a highlighted pill in the composer, so it is caught before Send rather than after.
      </p>

      {picker && (
        <PersonPicker
          title="Preview as"
          hint="Pick a real person; the preview merges their details the way Send would."
          onPick={(p) => {
            setPicker(false);
            setPerson(p);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </>
  );
}

function TemplateRow({ t, on, used, onPick }: { t: Template; on: boolean; used: QuickButton[]; onPick: () => void }) {
  return (
    <li className={on ? "on" : ""} onClick={onPick} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPick()}>
      <b>{t.name}</b>
      <span className="sub">{t.subject || "(no subject)"}</span>
      <span className="tp-use">
        {used.length === 0 ? (
          <span className="none">composer only</span>
        ) : (
          used.map((b) => (
            <span key={b.key} className={b.key.startsWith("home") ? "home" : ""} title={`Sent when ${b.sentence}`}>
              {b.short} · {b.label}
            </span>
          ))
        )}
      </span>
    </li>
  );
}
