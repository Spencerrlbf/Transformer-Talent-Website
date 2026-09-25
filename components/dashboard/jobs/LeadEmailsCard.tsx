"use client";
// Who gets an email when someone applies to this job: the job's recruiter
// (whoever created it) by default. Teammates only: people are picked from the
// company's own team, and the server checks each one. Nobody chosen means the
// company's owners get the email.
import { useMemo, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

export type Teammate = { userId: string; email: string; name: string | null; owner: boolean };

export default function LeadEmailsCard({
  jobId,
  initial,
}: {
  jobId: string;
  initial: { userIds: string[]; team: Teammate[] };
}) {
  const { token } = useDash();
  const [ids, setIds] = useState<string[]>(initial.userIds);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const team = initial.team;
  const byId = useMemo(() => new Map(team.map((t) => [t.userId, t])), [team]);
  const others = team.filter((t) => !ids.includes(t.userId));
  const label = (t: Teammate) => t.name || t.email;

  async function save(next: string[]) {
    setState("saving");
    try {
      const res = await fetch(`/api/dashboard/jobs/${jobId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ notifyUserIds: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setIds(next);
      setState("saved");
    } catch {
      setState("error");
    }
  }

  return (
    <>
      <div className="dash-sec">
        Lead emails
        {state === "saving" && <span className="jobws-savenote"> · Saving…</span>}
        {state === "saved" && <span className="jobws-savenote ok"> · Saved ✓</span>}
        {state === "error" && <span className="jobws-savenote err"> · Couldn&apos;t save</span>}
      </div>
      <div className="clc">
        {ids.length > 0 ? (
          <div className="jobws-cochips">
            {ids.map((u) => {
              const t = byId.get(u);
              if (!t) return null;
              return (
                <span key={u} className="jobws-cochip" title={t.email}>
                  {label(t)}
                  <button
                    type="button"
                    aria-label={`Stop emailing ${label(t)}`}
                    disabled={state === "saving"}
                    onClick={() => save(ids.filter((x) => x !== u))}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        ) : (
          <p className="clc-state">Nobody chosen: your company&apos;s owners get these emails.</p>
        )}
        {others.length > 0 && (
          <select
            value=""
            disabled={state === "saving"}
            onChange={(e) => e.target.value && save([...ids, e.target.value])}
          >
            <option value="">Add a teammate…</option>
            {others.map((t) => (
              <option key={t.userId} value={t.userId}>
                {t.name ? `${t.name} · ${t.email}` : t.email}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="jobws-hint">
        Everyone here gets an email when someone applies to this job. Only people on your team can be
        added.
      </p>
    </>
  );
}
