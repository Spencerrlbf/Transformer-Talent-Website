"use client";
// One note modal: create and edit (author-only — the server enforces it, the
// timeline only offers Edit on your own notes). Picking a channel seeds
// "Email {name}: …" while the text is still untouched.
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import KindIcon from "@/components/dashboard/tasks/KindIcon";

export type NoteModalTarget =
  | { mode: "create"; candidateKey: string; candidateName: string }
  | { mode: "edit"; candidateName: string; note: { id: string; kind: string; body: string } };

const NOTE_KINDS = ["note", "call", "email", "message"] as const;
const NOTE_LABEL: Record<string, string> = { note: "Note", call: "Call", email: "Email", message: "Message" };
const SEED_RE = /^(Call|Email|Message) [^:]{0,60}: ?$/;

export default function NoteModal({
  target,
  onClose,
  onChanged,
}: {
  target: NoteModalTarget;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { token } = useDash();
  const creating = target.mode === "create";
  const first = target.candidateName.split(/\s+/)[0] || target.candidateName;

  const [kind, setKind] = useState(creating ? "note" : target.note.kind);
  const [body, setBody] = useState(creating ? "" : target.note.body);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

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

  function pickKind(k: string) {
    setKind(k);
    if (body.trim() === "" || SEED_RE.test(body)) {
      setBody(k === "note" ? "" : `${NOTE_LABEL[k]} ${first}: `);
    }
  }

  async function save() {
    if (saving || !body.trim()) return;
    setSaving(true);
    setErr("");
    const res = creating
      ? await fetch(`/api/dashboard/candidates/v2/${target.candidateKey}/timeline`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ kind, body }),
        }).catch(() => null)
      : await fetch(`/api/dashboard/notes/${target.note.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ kind, body }),
        }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    setSaving(false);
    if (res?.ok) {
      onChanged();
      onClose();
    } else {
      setErr(json.error || "Couldn't save the note. Try again.");
    }
  }

  async function remove() {
    if (creating || saving) return;
    setSaving(true);
    setErr("");
    const res = await fetch(`/api/dashboard/notes/${target.note.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      onChanged();
      onClose();
    } else {
      setErr("Couldn't delete. Try again.");
    }
  }

  return (
    <div className="tkm-back" onClick={onClose}>
      <div className="tkm" onClick={(e) => e.stopPropagation()}>
        <h3>{creating ? `Add note about ${first}` : "Edit note"}</h3>
        <p className="tkm-sub">Shared with your team, with your name on it.</p>

        <div className="lbl">Type</div>
        <div className="cv2n-kinds">
          {NOTE_KINDS.map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => pickKind(k)}>
              <KindIcon kind={k} className="tk-ico" />
              {NOTE_LABEL[k]}
            </button>
          ))}
        </div>

        <div className="lbl">Note</div>
        <textarea
          className="tkm-text tkm-note"
          placeholder={`Add a note about ${first}…`}
          value={body}
          maxLength={4000}
          autoFocus
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save();
          }}
        />

        {err && <p className="cv2d-err">{err}</p>}
        <div className="tkm-foot">
          {!creating && (
            <button className="tkm-del" disabled={saving} onClick={remove}>
              Delete note
            </button>
          )}
          <button className="tkm-cancel" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button className="tkm-save" disabled={saving || !body.trim()} onClick={save}>
            {saving ? "SAVING…" : creating ? "SAVE NOTE" : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  );
}
