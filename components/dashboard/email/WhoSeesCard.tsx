"use client";
// Team page (owner only): who sees what. Applications and asks are the
// team's pipeline and always shared; email conversations are private to
// each mailbox unless the owner opens them to the team. One switch, applied
// in one place server-side (Inbox, Email tab, timeline, badges).
import { useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type Vis = "private" | "team";

export default function WhoSeesCard() {
  const { token } = useDash();
  const [vis, setVis] = useState<Vis | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/org", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ emailVisibility: Vis }>) : null))
      .then((j) => setVis(j?.emailVisibility === "team" ? "team" : "private"))
      .catch(() => setVis("private"));
  }, [token]);

  const choose = async (v: Vis) => {
    if (saving || v === vis) return;
    const prev = vis;
    setVis(v);
    setSaving(true);
    setNotice("");
    const res = await fetch("/api/dashboard/org", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ emailVisibility: v }),
    }).catch(() => null);
    setSaving(false);
    if (res?.ok) {
      setNotice(v === "team" ? "Email conversations are now shared with the team." : "Email conversations are now private to each mailbox.");
    } else {
      setVis(prev);
      setNotice("Couldn't save — try again.");
    }
  };

  return (
    <div className="em-card ws-card">
      <span className="lbl">Who sees what</span>
      <h4 className="ws-h">Candidate activity</h4>
      <p className="ws-p">
        Applications and &ldquo;hear from me later&rdquo; asks are shared: they&apos;re the team&apos;s
        pipeline, and everyone gets them in their own Inbox.
      </p>
      <div className="ws-fixed">
        Applications and asks <span className="ws-chip">Everyone</span>
      </div>
      <h4 className="ws-h">Email conversations</h4>
      <p className="ws-p">
        Each recruiter sends from their own mailbox. Choose whether their threads stay with them or are
        open to the team.
      </p>
      {(
        [
          [
            "private",
            "Private to each mailbox",
            "Only the recruiter whose mailbox sent or received a thread sees it: in their Inbox, in the candidate's Email tab, and in the timeline. Teammates see that an email happened, without the subject or content.",
          ],
          [
            "team",
            "Shared with the team",
            "Every member sees every candidate thread and can pick up an Inbox item from a colleague's mailbox. Replies still go out from the replier's own mailbox as a fresh email.",
          ],
        ] as [Vis, string, string][]
      ).map(([v, title, desc]) => (
        <button
          key={v}
          type="button"
          className={`ws-opt${vis === v ? " on" : ""}`}
          disabled={saving || vis === null}
          onClick={() => choose(v)}
        >
          <span className="ws-rb" aria-hidden="true" />
          <span>
            <b>{title}</b>
            <span>{desc}</span>
          </span>
        </button>
      ))}
      {notice && <p className={`em-cardnote${notice.startsWith("Couldn") ? " bad" : " ok"}`}>{notice}</p>}
    </div>
  );
}
