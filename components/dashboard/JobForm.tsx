"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDash } from "./DashShell";
import {
  ROLE_CITY_OPTIONS,
  WORKPLACE_OPTIONS,
  VISA_OPTIONS,
  MIN_JD_CHARS,
  MIN_ABOUT_CHARS,
  MIN_DOING,
  MIN_NEEDS,
} from "@/lib/role-options";

export type SkillChip = { skill: string; must_have: boolean; alternates: string[] };

export type JobFormValues = {
  title: string;
  roleType: string;
  salary: string;
  yoeMin: string;
  yoeMax: string;
  visa: string[];
  workplace: string[];
  locations: string[];
  about: string;
  doing: string[];
  needs: string[];
  bonus: string[];
  skills: SkillChip[];
};

export const EMPTY_JOB: JobFormValues = {
  title: "",
  roleType: "",
  salary: "",
  yoeMin: "",
  yoeMax: "",
  visa: [],
  workplace: [],
  locations: [],
  about: "",
  doing: [],
  needs: [],
  bonus: [],
  skills: [],
};

const ERROR_TEXT: Record<string, string> = {
  about_too_short: `"About the role" needs at least ${MIN_ABOUT_CHARS} characters — the screening engine reads it.`,
  not_enough_responsibilities: `Add at least ${MIN_DOING} responsibilities.`,
  not_enough_requirements: `Add at least ${MIN_NEEDS} requirements.`,
  yoe_max_below_min: "Max years can't be below min years.",
  title_required: "Job title is required.",
  at_least_one_skill: "Add at least one skill, and mark your true must-haves.",
  synced_role_readonly: "This role is managed by Transformer Talent — contact us to change it.",
};

function ListEditor({
  label,
  items,
  onChange,
  placeholder,
  min,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  min?: number;
}) {
  return (
    <div className="dash-field dash-span2">
      <label>
        {label}
        {min ? <em className="dash-min"> · at least {min}</em> : null}
      </label>
      {items.map((item, i) => (
        <div className="dash-listrow" key={i}>
          <input
            value={item}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button
            type="button"
            className="dash-skill-x"
            title="Remove"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" className="dash-addrow" onClick={() => onChange([...items, ""])}>
        + Add {label.toLowerCase().replace(/s$/, "")}
      </button>
    </div>
  );
}

function MultiSelect({
  label,
  options,
  value,
  onChange,
  size,
}: {
  label: string;
  options: readonly string[];
  value: string[];
  onChange: (v: string[]) => void;
  size: number;
}) {
  return (
    <div className="dash-field">
      <label>{label}</label>
      <select
        multiple
        size={size}
        value={value}
        onChange={(e) => onChange(Array.from(e.target.selectedOptions).map((o) => o.value))}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <small className="dash-selecthint">
        {value.length ? value.join(", ") : "None selected"} — ⌘/Ctrl-click for multiple
      </small>
    </div>
  );
}

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
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [newSkill, setNewSkill] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (k: keyof JobFormValues, val: JobFormValues[keyof JobFormValues]) =>
    setV((p) => ({ ...p, [k]: val }));
  const setSkills = (skills: SkillChip[]) => setV((p) => ({ ...p, skills }));

  function applyExtraction(data: {
    extracted: Record<string, unknown>;
    warnings?: string[];
  }) {
    const e = data.extracted as {
      title: string; role_type: string; salary: string;
      yoe_min: number | null; yoe_max: number | null;
      visa_options: string[]; workplace: string[]; locations: string[];
      about: string; doing: string[]; needs: string[]; bonus: string[];
      skills: SkillChip[];
    };
    setV({
      title: e.title || "",
      roleType: e.role_type || "",
      salary: e.salary || "",
      yoeMin: e.yoe_min != null ? String(e.yoe_min) : "",
      yoeMax: e.yoe_max != null ? String(e.yoe_max) : "",
      visa: e.visa_options || [],
      workplace: e.workplace || [],
      locations: e.locations || [],
      about: e.about || "",
      doing: e.doing || [],
      needs: e.needs || [],
      bonus: e.bonus || [],
      skills: e.skills || [],
    });
    setWarnings(data.warnings || []);
    setPrefilled(true);
  }

  async function runExtract(req: () => Promise<Response>) {
    setError("");
    setExtracting(true);
    try {
      const r = await req();
      const data = await r.json();
      if (!r.ok) {
        setError(
          data.error === "jd_too_short"
            ? `That job description is too short — we need at least ${MIN_JD_CHARS} characters to extract from.`
            : data.error === "pdf_unreadable"
              ? "Couldn't read that PDF — try pasting the text instead."
              : "Couldn't read that job description — try again or fill the form manually."
        );
        return;
      }
      applyExtraction(data);
    } catch {
      setError("Couldn't read that job description — try again or fill the form manually.");
    } finally {
      setExtracting(false);
    }
  }

  const prefillFromText = () =>
    runExtract(() =>
      fetch("/api/dashboard/jobs/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text: jdText }),
      })
    );

  const prefillFromFile = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return runExtract(() =>
      fetch("/api/dashboard/jobs/extract", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      })
    );
  };

  async function save() {
    setError("");
    if (!v.title.trim()) return setError(ERROR_TEXT.title_required);
    if (v.about.trim().length < MIN_ABOUT_CHARS) return setError(ERROR_TEXT.about_too_short);
    if (v.doing.filter((x) => x.trim()).length < MIN_DOING)
      return setError(ERROR_TEXT.not_enough_responsibilities);
    if (v.needs.filter((x) => x.trim()).length < MIN_NEEDS)
      return setError(ERROR_TEXT.not_enough_requirements);
    if (v.skills.length === 0) return setError(ERROR_TEXT.at_least_one_skill);
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
      const code = String(e).replace(/^Error:\s*/, "");
      setError(ERROR_TEXT[code] || "Publishing failed — nothing was lost, try again.");
    }
  }

  return (
    <div className="dash-jobform">
      {!jobId && (
        <div className="dash-prefill">
          <label>Have a job description already? Upload or paste it and we&apos;ll fill the form.</label>
          <div className="dash-prefill-actions">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) prefillFromFile(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="dash-btn dash-btn-2"
              disabled={extracting}
              onClick={() => fileRef.current?.click()}
            >
              {extracting ? "Reading…" : "Upload JD (PDF)"}
            </button>
            <span className="dash-muted">or paste below</span>
          </div>
          <textarea
            rows={5}
            placeholder="Paste your full job description here…"
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
          />
          <button
            type="button"
            className="dash-btn dash-btn-2"
            onClick={prefillFromText}
            disabled={extracting || jdText.trim().length < 50}
          >
            {extracting ? "Reading…" : "Prefill form from pasted JD"}
          </button>
          {prefilled && (
            <p className="dash-prefill-note">
              Form filled from your JD. Review every field — especially the skills below:
              confirm what&apos;s truly a must-have and which alternatives you&apos;d accept.
            </p>
          )}
          {warnings.length > 0 && (
            <ul className="dash-warnings">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
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
          <label>Min years of experience</label>
          <input
            type="number"
            min={0}
            max={40}
            value={v.yoeMin}
            onChange={(e) => set("yoeMin", e.target.value)}
            placeholder="3"
          />
        </div>
        <div className="dash-field">
          <label>Max years of experience</label>
          <input
            type="number"
            min={0}
            max={40}
            value={v.yoeMax}
            onChange={(e) => set("yoeMax", e.target.value)}
            placeholder="6 (blank = open)"
          />
        </div>
        <MultiSelect
          label="Workplace"
          options={WORKPLACE_OPTIONS}
          value={v.workplace}
          onChange={(x) => set("workplace", x)}
          size={3}
        />
        <MultiSelect
          label="Locations"
          options={ROLE_CITY_OPTIONS}
          value={v.locations}
          onChange={(x) => set("locations", x)}
          size={6}
        />
        <MultiSelect
          label="Visa"
          options={VISA_OPTIONS}
          value={v.visa}
          onChange={(x) => set("visa", x)}
          size={5}
        />
        <div className="dash-field dash-span2">
          <label>
            About the role * <em className="dash-min">· at least {MIN_ABOUT_CHARS} characters</em>
          </label>
          <textarea
            rows={4}
            value={v.about}
            onChange={(e) => set("about", e.target.value)}
            placeholder="What the company does, why the role exists, and what this person will own."
          />
          <small className="dash-selecthint">{v.about.trim().length} characters</small>
        </div>
        <ListEditor
          label="Responsibilities"
          items={v.doing}
          onChange={(x) => set("doing", x)}
          placeholder="e.g. Own our transaction-processing services end to end"
          min={MIN_DOING}
        />
        <ListEditor
          label="Requirements"
          items={v.needs}
          onChange={(x) => set("needs", x)}
          placeholder="e.g. Production experience with PostgreSQL at scale"
          min={MIN_NEEDS}
        />
        <ListEditor
          label="Nice to haves"
          items={v.bonus}
          onChange={(x) => set("bonus", x)}
          placeholder="e.g. Prior fintech experience"
        />
      </div>

      <div className="dash-skills">
        <label>Skills — set each to must-have or nice-to-have, and list alternatives you&apos;d accept</label>
        {v.skills.length === 0 && (
          <p className="dash-muted">No skills yet — prefill from a JD or add them below.</p>
        )}
        {v.skills.map((s, i) => (
          <div className="dash-skill" key={`${s.skill}-${i}`}>
            <span className="dash-skill-name">{s.skill}</span>
            <span className="dash-seg">
              <button
                type="button"
                className={s.must_have ? "on" : ""}
                onClick={() =>
                  setSkills(v.skills.map((x, j) => (j === i ? { ...x, must_have: true } : x)))
                }
              >
                MUST-HAVE
              </button>
              <button
                type="button"
                className={!s.must_have ? "on nice" : "nice"}
                onClick={() =>
                  setSkills(v.skills.map((x, j) => (j === i ? { ...x, must_have: false } : x)))
                }
              >
                NICE-TO-HAVE
              </button>
            </span>
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
              type="button"
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
