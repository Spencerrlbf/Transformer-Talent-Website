"use client";
// The bulk bar's modals: Add to list (pick one or type a new name to create
// it on the spot), Add to a job (manual attachment — pipeline at New, no
// invented verdict), and Manage lists (rename / delete named lists; the
// built-in Shortlist accepts neither). All reuse the tkm modal shell.
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

export type ListInfo = {
  id: string;
  name: string;
  builtin: boolean;
  createdByEmail: string;
  createdAt: string;
  count: number;
};

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", h, true);
    return () => document.removeEventListener("keydown", h, true);
  }, [onClose]);
}

const who = (email: string) => {
  const local = email.split("@")[0] || "";
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
};

export function AddToListModal({
  lists,
  count,
  keys,
  onClose,
  onDone,
}: {
  lists: ListInfo[];
  count: number;
  keys: string[];
  onClose: () => void;
  /** name of the list people were added to */
  onDone: (listName: string) => void;
}) {
  const { token } = useDash();
  const [picked, setPicked] = useState<string>(lists.find((l) => l.builtin)?.id || "");
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  useEscape(onClose);

  const creating = newName.trim().length > 0;

  async function save() {
    if (saving || (!picked && !creating)) return;
    setSaving(true);
    setErr("");
    let listId = picked;
    let listName = lists.find((l) => l.id === picked)?.name || "";
    if (creating) {
      const res = await fetch("/api/dashboard/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newName }),
      }).catch(() => null);
      const json = res?.ok ? await res.json().catch(() => null) : null;
      if (!json?.list) {
        setSaving(false);
        setErr("Couldn't create the list. Try again.");
        return;
      }
      listId = json.list.id;
      listName = json.list.name;
    }
    const res = await fetch(`/api/dashboard/lists/${listId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ keys }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      onDone(listName);
      onClose();
    } else {
      setErr("Couldn't add them. Try again.");
    }
  }

  return (
    <div className="tkm-back" onClick={onClose}>
      <div className="tkm" onClick={(e) => e.stopPropagation()}>
        <h3>
          Add {count} candidate{count === 1 ? "" : "s"} to a list
        </h3>
        <p className="tkm-sub">Lists are shared with your team. A person can be on several.</p>

        {lists.map((l) => (
          <div
            key={l.id}
            className={`blk-row${picked === l.id && !creating ? " on" : ""}`}
            role="button"
            onClick={() => {
              setPicked(l.id);
              setNewName("");
            }}
          >
            <span className="blk-radio" />
            <span className="t">
              <b>
                {l.builtin ? "★ " : ""}
                {l.name}
              </b>
              <span>{l.builtin ? "built-in" : who(l.createdByEmail) ? `by ${who(l.createdByEmail)}` : ""}</span>
            </span>
            <span className="n">
              {l.count} {l.count === 1 ? "person" : "people"}
            </span>
          </div>
        ))}

        <div className={`blk-row new${creating ? " on" : ""}`}>
          <span className="blk-radio" />
          <input
            placeholder="＋ New list… type a name"
            value={newName}
            maxLength={60}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
          />
        </div>

        {err && <p className="cv2d-err">{err}</p>}
        <div className="tkm-foot">
          <button className="tkm-cancel" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="tkm-save" disabled={saving || (!picked && !creating)} onClick={save}>
            {saving ? "SAVING…" : "ADD TO LIST →"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AddToJobModal({
  jobs,
  count,
  keys,
  onClose,
  onDone,
}: {
  jobs: [string, string][];
  count: number;
  keys: string[];
  onClose: () => void;
  onDone: (jobTitle: string) => void;
}) {
  const { token } = useDash();
  const [picked, setPicked] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  useEscape(onClose);

  async function save() {
    if (saving || !picked) return;
    setSaving(true);
    setErr("");
    const res = await fetch("/api/dashboard/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId: picked, keys }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      onDone(jobs.find(([id]) => id === picked)?.[1] || "the job");
      onClose();
    } else {
      setErr("Couldn't add them. Try again.");
    }
  }

  return (
    <div className="tkm-back" onClick={onClose}>
      <div className="tkm" onClick={(e) => e.stopPropagation()}>
        <h3>
          Add {count} candidate{count === 1 ? "" : "s"} to a job
        </h3>
        <p className="tkm-sub">
          They join the job&apos;s pipeline at stage <b>New</b>, marked as added by your team. No AI
          verdict is invented for manual adds.
        </p>

        <div className="blk-scroll">
          {jobs.map(([id, title]) => (
            <div
              key={id}
              className={`blk-row${picked === id ? " on" : ""}`}
              role="button"
              onClick={() => setPicked(id)}
            >
              <span className="blk-radio" />
              <span className="t">
                <b>{title}</b>
                <span>#{id}</span>
              </span>
            </div>
          ))}
          {jobs.length === 0 && <p className="cv2n-empty">No open jobs yet.</p>}
        </div>

        {err && <p className="cv2d-err">{err}</p>}
        <div className="tkm-foot">
          <button className="tkm-cancel" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="tkm-save" disabled={saving || !picked} onClick={save}>
            {saving ? "ADDING…" : "ADD TO JOB →"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ManageListsModal({
  lists,
  onClose,
  onChanged,
}: {
  lists: ListInfo[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { token } = useDash();
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEscape(onClose);

  async function rename(id: string) {
    const name = (renames[id] ?? "").trim();
    const current = lists.find((l) => l.id === id);
    if (!name || !current || name === current.name || busy) return;
    setBusy(id);
    setErr("");
    const res = await fetch(`/api/dashboard/lists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    }).catch(() => null);
    setBusy(null);
    if (res?.ok) onChanged();
    else setErr("Couldn't rename — that name may be taken.");
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(id);
    setErr("");
    const res = await fetch(`/api/dashboard/lists/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    setBusy(null);
    setConfirming(null);
    if (res?.ok) onChanged();
    else setErr("Couldn't delete. Try again.");
  }

  return (
    <div className="tkm-back" onClick={onClose}>
      <div className="tkm" onClick={(e) => e.stopPropagation()}>
        <h3>Manage lists</h3>
        <p className="tkm-sub">
          Deleting a list never touches the people on it. The built-in ★ Shortlist stays put.
        </p>

        {lists.map((l) => (
          <div key={l.id} className="blk-row static">
            <span className="t">
              {l.builtin ? (
                <b>★ {l.name}</b>
              ) : (
                <input
                  className="blk-rename"
                  value={renames[l.id] ?? l.name}
                  maxLength={60}
                  disabled={busy === l.id}
                  onChange={(e) => setRenames((r) => ({ ...r, [l.id]: e.target.value }))}
                  onBlur={() => rename(l.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              )}
              <span>
                {l.count} {l.count === 1 ? "person" : "people"}
              </span>
            </span>
            {!l.builtin &&
              (confirming === l.id ? (
                <button className="blk-del sure" disabled={busy === l.id} onClick={() => remove(l.id)}>
                  {busy === l.id ? "…" : "Really delete?"}
                </button>
              ) : (
                <button className="blk-del" onClick={() => setConfirming(l.id)}>
                  Delete
                </button>
              ))}
          </div>
        ))}

        {err && <p className="cv2d-err">{err}</p>}
        <div className="tkm-foot">
          <button className="tkm-save" onClick={onClose}>
            DONE
          </button>
        </div>
      </div>
    </div>
  );
}
