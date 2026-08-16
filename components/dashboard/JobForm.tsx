"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDash } from "./DashShell";

export type SkillChip = { skill: string; must_have: boolean; alternates: string[] };

export type JobFormValues = {
  title: string;
  roleType: string;
  salary: string;
  yoe: string;
  visa: string;
  workplace: string;
  locations: string;
  about: string;
  doing: string;
  needs: string;
  bonus: string;
  skills: SkillChip[];
};

export const EMPTY_JOB: JobFormValues = {
  title: "",
  roleType: "",
  salary: "",
  yoe: "",
  visa: "",
  workplace: "",
  locations: "",
  about: "",
  doing: "",
  needs: "",
  bonus: "",
  skills: [],
};

export default function JobForm({
  initial,
  jobId,
}: {
  initial: JobFormValues;
  jobId?: string; // present = edit mode
}) {
  const { token } = useDash();
  const router = useRouter();
  const [v, setV] = useState<JobFormValues>(initial);
  const [jdText, setJdText] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [newSkill, setNewSkill] = useState("");

  const set = (k: keyof JobFormValues, val: string) => setV((p) => ({ ...p, [k]: val }));
  const setSkills = (skills: SkillChip[]) => setV((p) => ({ ...p, skills }));

  async function prefill() {
    if (jdText.trim().length < 100) {
      setError("Paste the full job description first (at least a few sentences).");
      return;
    }
    setError("");
    setExtracting(true);
    try {
      const r = await fetch("/api/dashboard/jobs/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: jdText }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const { extracted: e } = await r.json();
      setV({
        title: e.title || "",
        roleType: e.role_type || "",
        salary: e.salary || "",
        yoe: e.yoe || "",
        visa: e.visa || "",
        workplace: e.workplace || "",
        locations: (e.locations || []).join(", "),
        about: e.about || "",
        doing: (e.doing || []).join("\n"),
        needs: (e.needs || []).join("\n"),
        bonus: (e.bonus || []).join("\n"),
        skills: e.skills || [],
      });
      setPrefilled(true);
    } catch {
      setError("Couldn't read that job description — try again or fill the form manually.");
    } finally {
      setExtracting(false);
    }
  }

  async function save() {
    setError("");
    if (!v.title.trim()) return setError("Job title is required.");
    if (v.skills.length === 0)
      return setError("Add at least one skill, and mark your true must-haves.");
    if (!v.about.trim() && !v.needs.trim())
      return setError("Add an about section or requirements — the screening engine needs them.");
    setSaving(true);
    try {
      const r = await fetch(jobId ? `/api/dashboard/jobs/${jobId}` : "/api/dashboard/jobs", {
        method: jobId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(v),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || String(r.status));
      router.push(`/dashboard/jobs/${data.id}`);
    } catch (e) {
      setSaving(false);
      setError(
        String(e).includes("synced_role_readonly")
          ? "This role is managed by Transformer Talent — contact us to change it."
          : "Publishing failed — nothing was lost, try again."
      );
    }
  }

  return (
    <div className="dash-jobform">
      {!jobId && (
        <div className="dash-prefill">
          <label>Have a job description already? Paste it and we&apos;ll fill the form.</label>
          <textarea
            rows={5}
            placeholder="Paste your full job description here…"
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
          />
          <button className="dash-btn dash-btn-2" onClick={prefill} disabled={extracting}>
            {extracting ? "Reading…" : "Prefill form from JD"}
          </button>
          {prefilled && (
            <p className="dash-prefill-note">
              Form filled from your JD. Review every field — especially the skills below:
              confirm what&apos;s truly a must-have and which alternatives you&apos;d accept.
            </p>
          )}
        </div>
      )}

      <div className="dash-formgrid">
        <div className="dash-field dash-span2">
          <label>Job title *</label>
          <input value={v.title} onChange={(e) => set("title", e.target.value)} placeholder="Senior Backend Engineer" />
        </div>
        <div className="dash-field">
          <label>Role type</label>
          <input value={v.roleType} onChange={(e) => set("roleType", e.target.value)} placeholder="Backend" />
        </div>
        <div className="dash-field">
          <label>Salary range</label>
          <input value={v.salary} onChange={(e) => set("salary", e.target.value)} placeholder="$150K - $200K" />
        </div>
        <div className="dash-field">
          <label>Years of experience</label>
          <input value={v.yoe} onChange={(e) => set("yoe", e.target.value)} placeholder="3 - 6 years" />
        </div>
        <div className="dash-field">
          <label>Workplace</label>
          <select value={v.workplace} onChange={(e) => set("workplace", e.target.value)}>
            <option value="">—</option>
            <option>Remote</option>
            <option>Hybrid</option>
            <option>On-site</option>
          </select>
        </div>
        <div className="dash-field">
          <label>Locations (comma-separated)</label>
          <input value={v.locations} onChange={(e) => set("locations", e.target.value)} placeholder="New York, San Francisco" />
        </div>
        <div className="dash-field">
          <label>Visa</label>
          <input value={v.visa} onChange={(e) => set("visa", e.target.value)} placeholder="Transfers OK / No sponsorship" />
        </div>
        <div className="dash-field dash-span2">
          <label>About the role</label>
          <textarea rows={3} value={v.about} onChange={(e) => set("about", e.target.value)} placeholder="2-3 sentences on the company and what this person will own." />
        </div>
        <div className="dash-field dash-span2">
          <label>Responsibilities (one per line)</label>
          <textarea rows={4} value={v.doing} onChange={(e) => set("doing", e.target.value)} />
        </div>
        <div className="dash-field dash-span2">
          <label>Requirements (one per line)</label>
          <textarea rows={4} value={v.needs} onChange={(e) => set("needs", e.target.value)} />
        </div>
        <div className="dash-field dash-span2">
          <label>Nice to have (one per line)</label>
          <textarea rows={2} value={v.bonus} onChange={(e) => set("bonus", e.target.value)} />
        </div>
      </div>

      <div className="dash-skills">
        <label>
          Skills — mark each as <b>MUST</b> or <b>NICE</b>, and list alternatives you&apos;d
          accept for must-haves
        </label>
        {v.skills.length === 0 && (
          <p className="dash-muted">No skills yet — prefill from a JD or add them below.</p>
        )}
        {v.skills.map((s, i) => (
          <div className="dash-skill" key={`${s.skill}-${i}`}>
            <button
              className={`dash-skill-flag ${s.must_have ? "must" : ""}`}
              title="Toggle must-have / nice-to-have"
              onClick={() =>
                setSkills(v.skills.map((x, j) => (j === i ? { ...x, must_have: !x.must_have } : x)))
              }
            >
              {s.must_have ? "MUST" : "NICE"}
            </button>
            <span className="dash-skill-name">{s.skill}</span>
            <input
              className="dash-skill-alts"
              placeholder="accepted alternatives, comma-separated (e.g. Golang, Rust)"
              value={s.alternates.join(", ")}
              onChange={(e) =>
                setSkills(
                  v.skills.map((x, j) =>
                    j === i
                      ? { ...x, alternates: e.target.value.split(",").map((a) => a.trim()).filter(Boolean) }
                      : x
                  )
                )
              }
            />
            <button
              className="dash-skill-x"
              title="Remove skill"
              onClick={() => setSkills(v.skills.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </div>
        ))}
        <form
          className="dash-skill-add"
          onSubmit={(e) => {
            e.preventDefault();
            const skill = newSkill.trim();
            if (!skill || v.skills.some((s) => s.skill.toLowerCase() === skill.toLowerCase())) return;
            setSkills([...v.skills, { skill, must_have: false, alternates: [] }]);
            setNewSkill("");
          }}
        >
          <input
            placeholder="Add a skill (e.g. Python)"
            value={newSkill}
            onChange={(e) => setNewSkill(e.target.value)}
          />
          <button className="dash-btn dash-btn-2">Add</button>
        </form>
      </div>

      {error && <p className="dash-error">{error}</p>}
      <div className="dash-formfoot">
        <button className="dash-btn" onClick={save} disabled={saving}>
          {saving
            ? "Publishing… generating screening"
            : jobId
              ? "Save changes & republish"
              : "Publish job"}
        </button>
        <span className="dash-muted">
          Publishing generates this role&apos;s screening automatically — takes a few seconds.
        </span>
      </div>
    </div>
  );
}
