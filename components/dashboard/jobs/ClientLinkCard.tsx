"use client";
// TT-only: wire this TT job to a client org's job. The cross-org send bridge
// (Network page) delivers candidates into whatever this link points at.
// Unlinking never touches candidates already sent.
import { useEffect, useMemo, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

type LinkedOrgRole = { orgId: string; jobId: string } | null;
type ClientOrg = { id: string; slug: string; name: string; jobs: { id: string; title: string }[] };

export default function ClientLinkCard({
  jobId,
  initial,
  onSaved,
}: {
  jobId: string;
  initial: LinkedOrgRole;
  onSaved: (link: LinkedOrgRole) => void;
}) {
  const { token } = useDash();
  const [orgs, setOrgs] = useState<ClientOrg[] | null>(null);
  const [link, setLink] = useState<LinkedOrgRole>(initial);
  const [editing, setEditing] = useState(false);
  const [pickOrg, setPickOrg] = useState("");
  const [pickJob, setPickJob] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/dashboard/client-orgs", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => setOrgs(d?.orgs ?? []))
      .catch(() => setOrgs([]));
  }, [token]);

  const linkedOrg = useMemo(
    () => (link ? orgs?.find((o) => o.id === link.orgId) : undefined),
    [link, orgs]
  );
  const linkedJob = linkedOrg?.jobs.find((j) => j.id === link?.jobId);
  const pickedOrg = orgs?.find((o) => o.id === pickOrg);

  async function save(next: LinkedOrgRole) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/dashboard/jobs/${jobId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ linkedOrgRole: next }),
      });
      if (res.ok) {
        setLink(next);
        onSaved(next);
        setEditing(false);
      } else {
        setError("Couldn't save the link — please try again.");
      }
    } catch {
      setError("Couldn't save the link — please try again.");
    }
    setSaving(false);
  }

  if (!orgs) return null;

  return (
    <>
      <div className="dash-sec">Client link <span className="nw-navlock">TT</span></div>
      {!editing ? (
        <div className="clc">
          {link ? (
            <>
              <p className="clc-state">
                ⚡ Linked to <b>{linkedOrg?.name || "a client"}</b>
                {linkedJob ? <> · {linkedJob.title} #{linkedJob.id}</> : <> · job #{link.jobId}</>}
              </p>
              <small className="clc-note">
                Network sends for this role are delivered straight into their pipeline.
              </small>
              <div className="clc-btns">
                <button
                  className="stg-editbtn"
                  onClick={() => {
                    setPickOrg(link.orgId);
                    setPickJob(link.jobId);
                    setEditing(true);
                  }}
                >
                  Change
                </button>
                <button className="stg-editbtn" disabled={saving} onClick={() => save(null)}>
                  {saving ? "…" : "Unlink"}
                </button>
              </div>
            </>
          ) : (
            <>
              <small className="clc-note">
                Not linked. Wire this job to a client company&apos;s job and Network sends will
                land in their pipeline instead of yours.
              </small>
              <button className="stg-editbtn" onClick={() => setEditing(true)}>
                Link to a client job
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="clc">
          <select
            value={pickOrg}
            onChange={(e) => {
              setPickOrg(e.target.value);
              setPickJob("");
            }}
          >
            <option value="">Choose a client company…</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select
            value={pickJob}
            onChange={(e) => setPickJob(e.target.value)}
            disabled={!pickedOrg}
          >
            <option value="">
              {pickedOrg
                ? pickedOrg.jobs.length
                  ? "Choose their job…"
                  : "No open jobs on their board"
                : "Choose a company first"}
            </option>
            {pickedOrg?.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title} · #{j.id}
              </option>
            ))}
          </select>
          <div className="clc-btns">
            <button
              className="dash-btn"
              disabled={saving || !pickOrg || !pickJob}
              onClick={() => save({ orgId: pickOrg, jobId: pickJob })}
            >
              {saving ? "Saving…" : "Save link"}
            </button>
            <button className="dash-btn dash-btn-2" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {error && <p className="dash-error">{error}</p>}
        </div>
      )}
    </>
  );
}
