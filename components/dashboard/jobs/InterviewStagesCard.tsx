"use client";
// Job workspace aside block: this job's interview stages (the steps between
// Replied and Offer). Shows the effective template with a Custom/Default
// badge; Edit opens the shared StageEditor. The board (task I2) reads the
// same template for its columns.
import { useCallback, useEffect, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import StageEditor, { type StageDef } from "@/components/dashboard/jobs/StageEditor";

export default function InterviewStagesCard({ jobId }: { jobId: string }) {
  const { token } = useDash();
  const [stages, setStages] = useState<StageDef[] | null>(null);
  const [custom, setCustom] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch(`/api/dashboard/jobs/${jobId}/stages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.stages) {
          setStages(d.stages);
          setCustom(!!d.custom);
        }
      })
      .catch(() => {});
  }, [jobId, token]);

  useEffect(load, [load]);

  async function put(body: { stages: StageDef[] | null }) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/dashboard/jobs/${jobId}/stages`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.stages) {
        setStages(json.stages);
        setCustom(!!json.custom);
        setEditing(false);
      } else {
        setError("Couldn't save — please try again.");
      }
    } catch {
      setError("Couldn't save — please try again.");
    }
    setSaving(false);
  }

  if (!stages) return null;

  return (
    <>
      <div className="dash-sec">
        Interview stages
        <span className={`stg-badge${custom ? " custom" : ""}`}>
          {custom ? "Custom" : "Company default"}
        </span>
      </div>
      <ol className="stg-list">
        {stages.map((s) => (
          <li key={s.id}>{s.label}</li>
        ))}
      </ol>
      <button className="stg-editbtn" onClick={() => setEditing(true)}>
        Edit stages
      </button>
      {editing && (
        <StageEditor
          title="Interview stages · this job"
          intro="The steps between Replied and Offer, in order. Drag to reorder, rename freely."
          initial={stages}
          showReset={custom}
          saving={saving}
          error={error}
          onSave={(s) => put({ stages: s })}
          onReset={() => put({ stages: null })}
          onClose={() => {
            setEditing(false);
            setError("");
          }}
        />
      )}
    </>
  );
}
