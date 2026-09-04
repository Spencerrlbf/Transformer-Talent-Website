"use client";
// Settings → Email templates: the wording the whole team sends, and which
// quick-action button sends which template. Wording is everyone's to edit;
// the mapping and Restore default are the owner's.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useDash } from "@/components/dashboard/DashShell";
import { TemplateEditor } from "@/components/dashboard/email/EmailModal";
import PersonPicker from "@/components/dashboard/home/PersonPicker";
import { QUICK_BUTTONS, fieldsUsed } from "@/lib/quick-buttons";
import { TEMPLATE } from "@/lib/quick-actions";
import { htmlToLines, mergeText, previewValues, type PreviewCtx } from "@/lib/email-preview";
import type { Template } from "@/lib/server/email-compose";

type Data = { templates: Template[]; buttons: Record<string, string | null>; canMap: boolean };

const stockName = (key: string) => Object.values(TEMPLATE).find((t) => t.key === key)?.name || "the stock wording";
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
  const buttons = data?.buttons || {};
  const byId = new Map(templates.map((t) => [t.id, t]));
  const defaultIdFor = (defaultKey: string) => templates.find((t) => t.actionKey === defaultKey)?.id || null;
  const usedBy = (id: string) => QUICK_BUTTONS.filter((b) => buttons[b.key] === id);
  const current = selected && selected !== "new" ? byId.get(selected) || null : null;
  const stock = templates.filter((t) => t.actionKey);
  const own = templates.filter((t) => !t.actionKey);
  const missing = QUICK_BUTTONS.filter((b) => !buttons[b.key]).length;

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
            Shared with your whole team. Fields like <code>{"{{first_name}}"}</code> fill in per person when a template is used; a field the composer can&apos;t fill is flagged before Send.{" "}
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
              <p className="cs">{data ? `${templates.length} · click to edit` : "Loading…"}</p>
            </div>
          </div>
          <ul className="tp-list">
            {stock.length > 0 && <li className="grp" style={{ cursor: "default" }}>Default wording</li>}
            {stock.map((t) => (
              <TemplateRow key={t.id} t={t} on={selected === t.id} used={usedBy(t.id)} onPick={() => startEdit(t)} />
            ))}
            {own.length > 0 && <li className="grp" style={{ cursor: "default" }}>Your own</li>}
            {own.map((t) => (
              <TemplateRow key={t.id} t={t} on={selected === t.id} used={usedBy(t.id)} onPick={() => startEdit(t)} />
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
                          `used by ${usedBy(current.id).length} button${usedBy(current.id).length === 1 ? "" : "s"}`,
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
                {current && usedBy(current.id).length > 0 && (
                  <p className="tp-fine" style={{ marginTop: 8 }}>
                    Used by {usedBy(current.id).map((b) => `${b.label} (${b.where})`).join(", ")}. Changes apply the next time any of them is pressed.
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

      <div className="tk-day-h hm-sec">
        Buttons <span className="hm-why">which template each quick action sends, and what Send does afterwards</span>
      </div>
      <div className="tp-card">
        <div className="board-scroll">
          <table className="tp-map">
            <thead>
              <tr>
                <th>Button</th>
                <th>Shows when</th>
                <th>Template</th>
                <th>Then</th>
              </tr>
            </thead>
            <tbody>
              {QUICK_BUTTONS.map((b, i) => {
                const head = i === 0 || QUICK_BUTTONS[i - 1].where !== b.where;
                const id = buttons[b.key];
                const t = id ? byId.get(id) : undefined;
                const isDefault = !id || id === defaultIdFor(b.defaultKey);
                const bad = t ? fieldsUsed(t.subject, t.bodyHtml).filter((f) => !b.fields.includes(f)) : [];
                return (
                  <FragmentRows key={b.key} head={head ? b.where : null}>
                    <td className="bt">
                      <b>{b.label}</b>
                      <small>{b.where}</small>
                    </td>
                    <td>{b.when}</td>
                    <td className="tpl">
                      {data?.canMap ? (
                        <select
                          className={t ? "" : "miss"}
                          value={t ? t.id : ""}
                          disabled={mapBusy === b.key}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (!v) return;
                            if (v === defaultIdFor(b.defaultKey)) post({ button: b.key, reset: true }, b.key);
                            else post({ button: b.key, templateId: v }, b.key);
                          }}
                        >
                          {!t && <option value="">No template</option>}
                          {templates.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span>{t ? t.name : <span className="hm-chip warn">No template</span>}</span>
                      )}
                      {t && (
                        <button type="button" className="hm-lnk" onClick={() => startEdit(t)}>
                          Edit
                        </button>
                      )}
                      {!t && (
                        <span className="note warn">
                          Template deleted.{" "}
                          {data?.canMap && (
                            <>
                              <button type="button" className="hm-lnk" disabled={mapBusy === b.key} onClick={() => post({ restore: b.key }, b.key)}>
                                Restore default ({stockName(b.defaultKey)})
                              </button>{" "}
                              or pick one.
                            </>
                          )}
                        </span>
                      )}
                      {t && bad.length > 0 && <span className="note warn">Uses {bad.map((f) => `{{${f}}}`).join(", ")}, which this button can&apos;t fill.</span>}
                      {t && bad.length === 0 && <span className="note ok">{isDefault ? "Stock wording · fills every field it uses." : "Fills every field it uses."}</span>}
                    </td>
                    <td className="then">{b.then}</td>
                  </FragmentRows>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="tp-mapfoot">
          <span>
            A button with no template says <b>template missing</b> in the composer and opens it empty. Restore default brings the stock wording back as a new template and maps the button to it.
            {missing > 0 ? ` ${missing} button${missing === 1 ? " needs" : "s need"} a template.` : ""}
          </span>
          {data?.canMap && (
            <button type="button" className="hm-lnk" disabled={mapBusy === "all"} onClick={() => post({ restoreAll: true }, "all")}>
              Restore all default wording
            </button>
          )}
        </div>
      </div>

      <p className="tp-fine">
        Every button fills name, sender, booking link, page link and tracked link. A button that names a role also fills the job title, company and role link. Drops, referrals and follow-ups fill matched roles; referrals fill the referrer; asks fill the month; in-thread buttons fill the subject. The table warns when a template uses a field its button can&apos;t fill, so nobody finds out at Send.
        {data && !data.canMap ? " Changing which template a button sends is for your company's owner account; the wording is everyone's to edit." : ""}
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

function TemplateRow({ t, on, used, onPick }: { t: Template; on: boolean; used: { key: string; label: string }[]; onPick: () => void }) {
  return (
    <li className={on ? "on" : ""} onClick={onPick} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onPick()}>
      <b>{t.name}</b>
      <span className="sub">{t.subject || "(no subject)"}</span>
      <span className="tp-use">
        {used.length === 0 ? <span>no button</span> : used.map((b) => <span key={b.key} className={b.key.startsWith("home") ? "home" : ""}>{b.label}</span>)}
      </span>
    </li>
  );
}

/** A table row, with a group header row above it when `head` is set. */
function FragmentRows({ head, children }: { head: string | null; children: React.ReactNode }) {
  return (
    <>
      {head && (
        <tr className="where">
          <td colSpan={4}>{head}</td>
        </tr>
      )}
      <tr>{children}</tr>
    </>
  );
}
