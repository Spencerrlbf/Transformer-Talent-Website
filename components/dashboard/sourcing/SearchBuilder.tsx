"use client";
// Sourcing search builder (Option A, state 1) + preview banner (state 2).
// Chips for every list filter, a live company typeahead, and the guardrail
// preview: "matches ~N → Import all" or "too broad → narrow it".
import { useEffect, useRef, useState } from "react";
import { useDash } from "../DashShell";
import { emptyQuery, queryFromDraft, type QueryDraft } from "./types";

const YOE_BANDS = [
  { id: "1", label: "Under 1 yr" },
  { id: "2", label: "1–2 yrs" },
  { id: "3", label: "3–5 yrs" },
  { id: "4", label: "6–10 yrs" },
  { id: "5", label: "10+ yrs" },
];
const HEADCOUNTS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001-10000", "10001+"];

type Preview =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; total: number; creditsAvailable: number }
  | { kind: "too_broad"; total: number; maxImport: number }
  | { kind: "no_matches" }
  | { kind: "error" };

function ChipInput({
  values, onChange, placeholder,
}: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim().replace(/,$/, "");
    if (t && !values.includes(t)) onChange([...values, t]);
    setText("");
  };
  return (
    <div className="dash-src-chips">
      {values.map((v) => (
        <span key={v} className="dash-src-chip">
          {v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
        </span>
      ))}
      <input
        value={text}
        placeholder={values.length ? "" : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

function CompanyPicker({
  draft, field, onChange,
}: { draft: QueryDraft; field: "currentCompanies" | "pastCompanies" | "excludeCurrentCompanies"; onChange: (d: QueryDraft) => void }) {
  const { token } = useDash();
  const [text, setText] = useState("");
  const [hits, setHits] = useState<{ name: string; linkedinUrl: string; location: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urls = draft[field];

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < 2) { setHits([]); return; }
    timer.current = setTimeout(() => {
      fetch(`/api/dashboard/sourcing/companies?q=${encodeURIComponent(text.trim())}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(async (r) => (r.ok ? r.json() : { companies: [] }))
        .then((d) => { setHits(d.companies || []); setOpen(true); })
        .catch(() => setHits([]));
    }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [text, token]);

  const pick = (hit: { name: string; linkedinUrl: string }) => {
    if (!urls.includes(hit.linkedinUrl)) {
      onChange({
        ...draft,
        [field]: [...urls, hit.linkedinUrl],
        companyLabels: { ...draft.companyLabels, [hit.linkedinUrl]: hit.name },
      });
    }
    setText(""); setHits([]); setOpen(false);
  };

  return (
    <div className="dash-src-copicker">
      <div className="dash-src-chips">
        {urls.map((u) => (
          <span key={u} className="dash-src-chip co">
            {draft.companyLabels[u] || u.replace(/\/$/, "").split("/").pop()}
            <button type="button" aria-label="Remove company" onClick={() => onChange({ ...draft, [field]: urls.filter((x) => x !== u) })}>×</button>
          </span>
        ))}
        <input
          value={text}
          placeholder={urls.length ? "" : "Type a company name…"}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => hits.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
      </div>
      {open && hits.length > 0 && (
        <div className="dash-src-codrop">
          {hits.map((h) => (
            <button type="button" key={h.linkedinUrl} onMouseDown={(e) => { e.preventDefault(); pick(h); }}>
              <b>{h.name}</b>
              {h.location && <small> — {h.location}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SearchBuilder({
  jobId, jobTitle, initial, onStarted, onCancel,
}: {
  jobId: string;
  jobTitle: string;
  initial?: QueryDraft | null;
  onStarted: (runId: string) => void;
  onCancel: () => void;
}) {
  const { token } = useDash();
  const [draft, setDraft] = useState<QueryDraft>(initial ?? emptyQuery(jobTitle));
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState<Preview>({ kind: "idle" });
  const [starting, setStarting] = useState(false);

  // Any edit invalidates the previewed count.
  const edit = (d: QueryDraft) => { setDraft(d); setPreview({ kind: "idle" }); };

  async function runPreview() {
    setPreview({ kind: "loading" });
    try {
      const res = await fetch("/api/dashboard/sourcing/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId, query: queryFromDraft(draft) }),
      });
      const d = await res.json();
      if (!res.ok) { setPreview({ kind: "error" }); return; }
      if (d.ok) setPreview({ kind: "ok", total: d.total, creditsAvailable: d.creditsAvailable ?? 0 });
      else if (d.code === "too_broad") setPreview({ kind: "too_broad", total: d.total, maxImport: d.maxImport });
      else if (d.code === "no_matches") setPreview({ kind: "no_matches" });
      else setPreview({ kind: "error" });
    } catch {
      setPreview({ kind: "error" });
    }
  }

  async function startRun(total: number) {
    setStarting(true);
    try {
      const res = await fetch("/api/dashboard/sourcing/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId, query: queryFromDraft(draft), matchEstimate: total }),
      });
      const d = await res.json();
      if (res.ok && d.run?.id) onStarted(d.run.id);
      else if (res.status === 402) {
        setPreview({ kind: "ok", total, creditsAvailable: d.available ?? 0 });
      } else setPreview({ kind: "error" });
    } catch {
      setPreview({ kind: "error" });
    } finally {
      setStarting(false);
    }
  }

  const toggle = (field: "yearsOfExperienceIds" | "companyHeadcount", id: string) => {
    const cur = draft[field];
    edit({ ...draft, [field]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };

  return (
    <div className="dash-src-builder">
      <div className="dash-src-card">
        <div className="dash-src-label">Job titles</div>
        <ChipInput values={draft.currentJobTitles} onChange={(v) => edit({ ...draft, currentJobTitles: v })} placeholder="Senior Backend Engineer, Backend Engineer…" />

        <div className="dash-src-label">Locations</div>
        <ChipInput values={draft.locations} onChange={(v) => edit({ ...draft, locations: v })} placeholder="New York, London, San Francisco…" />

        <div className="dash-src-label">Ideal companies <span>(currently there)</span></div>
        <CompanyPicker draft={draft} field="currentCompanies" onChange={edit} />

        <div className="dash-src-label">Ideal companies <span>(worked there before)</span></div>
        <CompanyPicker draft={draft} field="pastCompanies" onChange={edit} />

        <div className="dash-src-label">Keywords</div>
        <input
          className="dash-src-text"
          value={draft.search}
          placeholder="python, distributed systems, early-stage…"
          onChange={(e) => edit({ ...draft, search: e.target.value })}
        />

        <button type="button" className="dash-src-more" onClick={() => setMore(!more)}>
          {more ? "▾" : "▸"} More filters — experience, company size, schools, exclusions
        </button>
        {more && (
          <div className="dash-src-morebox">
            <div className="dash-src-label">Years of experience</div>
            <div className="dash-src-checks">
              {YOE_BANDS.map((b) => (
                <label key={b.id}>
                  <input type="checkbox" checked={draft.yearsOfExperienceIds.includes(b.id)} onChange={() => toggle("yearsOfExperienceIds", b.id)} />
                  {b.label}
                </label>
              ))}
            </div>
            <div className="dash-src-label">Company size</div>
            <div className="dash-src-checks">
              {HEADCOUNTS.map((h) => (
                <label key={h}>
                  <input type="checkbox" checked={draft.companyHeadcount.includes(h)} onChange={() => toggle("companyHeadcount", h)} />
                  {h}
                </label>
              ))}
            </div>
            <div className="dash-src-label">Schools</div>
            <ChipInput values={draft.schools} onChange={(v) => edit({ ...draft, schools: v })} placeholder="Stanford University, MIT…" />
            <div className="dash-src-label">Exclude companies</div>
            <CompanyPicker draft={draft} field="excludeCurrentCompanies" onChange={edit} />
            <div className="dash-src-label">Exclude locations</div>
            <ChipInput values={draft.excludeLocations} onChange={(v) => edit({ ...draft, excludeLocations: v })} placeholder="Add a location to exclude…" />
          </div>
        )}

        <div className="dash-src-actions">
          <button className="dash-btn" disabled={preview.kind === "loading"} onClick={runPreview}>
            {preview.kind === "loading" ? "Checking…" : "Preview matches"}
          </button>
          <button className="dash-btn dash-btn-2" onClick={onCancel}>Cancel</button>
        </div>
      </div>

      {preview.kind === "ok" && preview.creditsAvailable >= preview.total && (
        <div className="dash-src-preview ok">
          <div>
            <b>This search matches ~{preview.total.toLocaleString()} candidates</b>
            <small>
              Everyone who matches is imported and reviewed — {preview.total.toLocaleString()} credits
              (you have {preview.creditsAvailable.toLocaleString()}).
            </small>
          </div>
          <button className="dash-btn" disabled={starting} onClick={() => startRun(preview.total)}>
            {starting ? "Starting…" : `Import all ${preview.total.toLocaleString()}`}
          </button>
        </div>
      )}
      {preview.kind === "ok" && preview.creditsAvailable < preview.total && (
        <div className="dash-src-preview broad">
          <b>This search matches ~{preview.total.toLocaleString()} candidates — you have {preview.creditsAvailable.toLocaleString()} credits</b>
          <p>
            Importing costs 1 credit per candidate (review included). Narrow the search to fit your
            balance, or contact us to top up.
          </p>
        </div>
      )}
      {preview.kind === "too_broad" && (
        <div className="dash-src-preview broad">
          <b>Too broad — {preview.total.toLocaleString()} matches</b>
          <p>
            Narrow the search to {preview.maxImport.toLocaleString()} or fewer so every match can be imported
            and ranked. Try adding a location, an experience band, or a company-size filter.
          </p>
        </div>
      )}
      {preview.kind === "no_matches" && (
        <div className="dash-src-preview broad">
          <b>No matches</b>
          <p>Try removing a filter or loosening the titles.</p>
        </div>
      )}
      {preview.kind === "error" && (
        <div className="dash-src-preview broad">
          <b>Something went wrong</b>
          <p>The preview couldn&apos;t run. Try again in a moment.</p>
        </div>
      )}
    </div>
  );
}
