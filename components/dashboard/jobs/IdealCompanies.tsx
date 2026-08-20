"use client";
// Overview-tab editors for the role's dashboard-owned fields: the hiring
// company name (shown in the candidate drawer's pipeline table) and the
// ideal-companies list (feeds the AI review + prefills new searches).
import { useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";

export type TargetCompany = { name: string; linkedinUrl: string | null; logo: string | null };

type Hit = { name: string; linkedinUrl: string; location: string | null; followers: string | null; logo: string | null };

function ChipLogo({ logo, name }: { logo: string | null; name: string }) {
  const [broken, setBroken] = useState(false);
  if (!logo || broken)
    return <span className="jobws-cologo-fallback">{name.charAt(0).toUpperCase()}</span>;
  // LinkedIn CDN logo; expires after a few weeks — fall back to a letter tile.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logo} alt="" width={18} height={18} onError={() => setBroken(true)} />;
}

export function CompanyNameField({
  jobId, initial, onSaved,
}: { jobId: string; initial: string; onSaved: (name: string) => void }) {
  const { token } = useDash();
  const [value, setValue] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    const v = value.trim();
    if (v === initial.trim()) return;
    setState("saving");
    const res = await fetch(`/api/dashboard/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ companyName: v }),
    }).catch(() => null);
    if (res?.ok) {
      setState("saved");
      onSaved(v);
      setTimeout(() => setState("idle"), 1500);
    } else {
      setState("error");
    }
  }

  return (
    <>
      <div className="dash-sec">Company</div>
      <div className="jobws-conamerow">
        <input
          className="jobws-conameinput"
          value={value}
          placeholder="Hiring company name…"
          maxLength={120}
          onChange={(e) => { setValue(e.target.value); if (state !== "idle") setState("idle"); }}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        {state === "saving" && <span className="jobws-savenote">Saving…</span>}
        {state === "saved" && <span className="jobws-savenote ok">Saved ✓</span>}
        {state === "error" && <span className="jobws-savenote err">Couldn&apos;t save — try again</span>}
      </div>
      <p className="jobws-hint">Shown with this role in candidate profiles.</p>
    </>
  );
}

export function IdealCompanies({
  jobId, initial, onSaved,
}: { jobId: string; initial: TargetCompany[]; onSaved: (targets: TargetCompany[]) => void }) {
  const { token } = useDash();
  const [targets, setTargets] = useState<TargetCompany[]>(initial);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < 2) { setHits([]); setOpen(false); return; }
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

  async function save(next: TargetCompany[]) {
    const prev = targets;
    setTargets(next);
    setState("saving");
    const res = await fetch(`/api/dashboard/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetCompanies: next }),
    }).catch(() => null);
    if (res?.ok) {
      setState("saved");
      onSaved(next);
      setTimeout(() => setState("idle"), 1500);
    } else {
      setTargets(prev); // roll back — the UI never lies about what's stored
      setState("error");
    }
  }

  const pick = (h: Hit) => {
    setText(""); setHits([]); setOpen(false);
    if (targets.some((t) => t.name.toLowerCase() === h.name.toLowerCase())) return;
    if (targets.length >= 20) return;
    save([...targets, { name: h.name, linkedinUrl: h.linkedinUrl, logo: h.logo }]);
  };

  return (
    <>
      <div className="dash-sec">
        Ideal companies
        {state === "saving" && <span className="jobws-savenote"> · Saving…</span>}
        {state === "saved" && <span className="jobws-savenote ok"> · Saved ✓</span>}
        {state === "error" && <span className="jobws-savenote err"> · Couldn&apos;t save</span>}
      </div>
      <div className="jobws-copicker">
        <div className="jobws-cochips">
          {targets.map((t) => (
            <span key={t.name} className="jobws-cochip">
              <ChipLogo logo={t.logo} name={t.name} />
              {t.name}
              <button
                type="button"
                aria-label={`Remove ${t.name}`}
                onClick={() => save(targets.filter((x) => x.name !== t.name))}
              >
                ×
              </button>
            </span>
          ))}
          <input
            value={text}
            placeholder={targets.length ? "Add another…" : "Type a company name…"}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => hits.length && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
        </div>
        {open && hits.length > 0 && (
          <div className="dash-src-codrop">
            {hits.map((h) => (
              <button type="button" key={h.linkedinUrl} onMouseDown={(e) => { e.preventDefault(); pick(h); }}>
                {h.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.logo} alt="" width={28} height={28} loading="lazy" />
                ) : (
                  <span className="dash-src-cologo-fallback">{h.name.charAt(0).toUpperCase()}</span>
                )}
                <span className="dash-src-cotext">
                  <b>{h.name}</b>
                  <small>{[h.location, h.followers].filter(Boolean).join(" · ") || " "}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="jobws-hint">
        Companies whose engineers would be a great fit. The AI review treats experience at these
        companies as strong evidence, and new sourcing searches start pre-filled with them.
      </p>
    </>
  );
}
