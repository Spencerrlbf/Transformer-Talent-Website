"use client";
// Settings section: the company page editor (owner-only). Everything is
// optional — the public About tab renders only what's filled in. Interview
// rounds are their own blocks (seeded once from the interview stages, then
// free text — the public page no longer has to mirror the pipeline).
import { useCallback, useEffect, useRef, useState } from "react";
import { useDash } from "@/components/dashboard/DashShell";
import type {
  CompanyFounder,
  CompanyProfile,
  CompanyRound,
} from "@/lib/server/company-page";
import type { StageDef } from "@/components/dashboard/jobs/StageEditor";

type PageData = {
  profile: CompanyProfile;
  published: boolean;
  logoPath: string | null;
  logoUrl: string | null;
  stages: StageDef[];
  canEdit: boolean;
  boardUrl: string;
};

const rid = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 8)}`;
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

export default function CompanyPageEditor() {
  const { org, token } = useDash();
  const [data, setData] = useState<PageData | null>(null);
  const [p, setP] = useState<CompanyProfile | null>(null);
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [published, setPublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState("");
  const logoRef = useRef<HTMLInputElement>(null);
  const founderRef = useRef<HTMLInputElement>(null);
  const founderTarget = useRef<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/dashboard/company-page", { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => (r.ok ? ((await r.json()) as PageData) : null))
      .then((d) => {
        if (!d) return;
        setData(d);
        // Seed the rounds once from the interview stages so setup starts
        // non-empty; after that they're free text.
        const profile = { ...d.profile };
        if (profile.rounds.length === 0 && d.stages.length > 0) {
          profile.rounds = d.stages.map((s) => ({
            id: rid("r"),
            name: s.label,
            duration: "",
            hint: "",
            detail: "",
          }));
        }
        setP(profile);
        setLogoPath(d.logoPath);
        setLogoUrl(d.logoUrl);
        setPublished(d.published);
      })
      .catch(() => {});
  }, [token]);
  useEffect(load, [load]);

  async function save(nextPublished?: boolean) {
    if (!p) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const res = await fetch("/api/dashboard/company-page", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: p,
          logoPath,
          published: nextPublished === undefined ? published : nextPublished,
        }),
      });
      if (res.ok) {
        if (nextPublished !== undefined) setPublished(nextPublished);
        setSaved(true);
      } else setError("Couldn't save — please try again.");
    } catch {
      setError("Couldn't save — please try again.");
    }
    setSaving(false);
  }

  async function upload(file: File, kind: "logo" | "founder", founderId?: string) {
    setUploading(founderId || kind);
    setError("");
    const form = new FormData();
    form.set("photo", file);
    form.set("kind", kind === "logo" ? "logo" : "founder");
    try {
      const res = await fetch("/api/dashboard/company-page/photo", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.path) {
        if (kind === "logo") {
          setLogoPath(json.path as string);
          setLogoUrl(json.url as string);
        } else if (founderId) {
          setP((cur) =>
            cur
              ? {
                  ...cur,
                  founders: cur.founders.map((f) =>
                    f.id === founderId
                      ? { ...f, photoPath: json.path as string, photoUrl: json.url as string }
                      : f
                  ),
                }
              : cur
          );
        }
      } else setError("Upload failed — use a JPG, PNG, WebP, or SVG under 4MB.");
    } catch {
      setError("Upload failed — please try again.");
    }
    setUploading("");
  }

  function setField<K extends keyof CompanyProfile>(k: K, v: CompanyProfile[K]) {
    setP((cur) => (cur ? { ...cur, [k]: v } : cur));
    setSaved(false);
  }
  function setFounder(id: string, patch: Partial<CompanyFounder>) {
    setP((cur) =>
      cur
        ? { ...cur, founders: cur.founders.map((f) => (f.id === id ? { ...f, ...patch } : f)) }
        : cur
    );
    setSaved(false);
  }
  function setRound(id: string, patch: Partial<CompanyRound>) {
    setP((cur) =>
      cur ? { ...cur, rounds: cur.rounds.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : cur
    );
    setSaved(false);
  }
  function setSection(i: number, patch: Partial<{ title: string; subtitle: string; body: string }>) {
    setP((cur) => {
      if (!cur) return cur;
      const sections = [...cur.sections];
      const base = sections[i] ?? { title: "", subtitle: "", body: "" };
      sections[i] = { ...base, ...patch };
      return { ...cur, sections };
    });
    setSaved(false);
  }

  if (!data || !p) return null;
  if (!data.canEdit) {
    return (
      <div className="dash-setting">
        <label>Company page</label>
        <div>
          <small>
            {published ? (
              <>Published at <a href={data.boardUrl} target="_blank" rel="noreferrer">{data.boardUrl}</a>. Edited by your company&apos;s owner account.</>
            ) : (
              <>Not published yet. Set up by your company&apos;s owner account.</>
            )}
          </small>
        </div>
      </div>
    );
  }

  return (
    <div className="dash-setting cpe">
      <label>Company page</label>
      <div>
        <small style={{ marginBottom: 10 }}>
          The public About tab on <a href={data.boardUrl} target="_blank" rel="noreferrer">{data.boardUrl}</a>.
          Sections appear only when filled in.
        </small>

        <div className="cpe-logo-row">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="cpe-logo" src={logoUrl} alt="Logo" />
          ) : (
            <div className="cpe-logo cpe-logo-fb">{initials(org.name)}</div>
          )}
          <button
            className="dash-btn dash-btn-2"
            disabled={uploading === "logo"}
            onClick={() => logoRef.current?.click()}
          >
            {uploading === "logo" ? "Uploading…" : logoUrl ? "Change logo" : "Upload logo"}
          </button>
          <input
            ref={logoRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/svg+xml"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f, "logo");
              e.target.value = "";
            }}
          />
        </div>

        <div className="dash-field"><label>Tagline (one line under your name)</label>
          <input value={p.tagline} maxLength={120} onChange={(e) => setField("tagline", e.target.value)} placeholder="What your company does, in one line" />
        </div>

        <div className="cpe-sub">Facts (chips under your name; each optional)</div>
        <div className="cpe-cardrow">
          <input value={p.headcount} maxLength={40} placeholder="120 people" onChange={(e) => setField("headcount", e.target.value)} />
          <input value={p.founded} maxLength={30} placeholder="Founded 2021" onChange={(e) => setField("founded", e.target.value)} />
        </div>
        <div className="cpe-cardrow">
          <input value={p.stage} maxLength={40} placeholder="Series B" onChange={(e) => setField("stage", e.target.value)} />
          <input value={p.funding} maxLength={40} placeholder="$40M raised" onChange={(e) => setField("funding", e.target.value)} />
        </div>
        <div className="cpe-cardrow">
          <input value={p.offices} maxLength={60} placeholder="SF · NYC" onChange={(e) => setField("offices", e.target.value)} />
          <input value={p.workEnv} maxLength={40} placeholder="Hybrid / Remote / On-site" onChange={(e) => setField("workEnv", e.target.value)} />
        </div>

        <div className="dash-field"><label>Mission headline (the big statement)</label>
          <textarea value={p.missionHeadline} rows={2} maxLength={220} onChange={(e) => setField("missionHeadline", e.target.value)} />
        </div>
        <div className="dash-field"><label>Mission detail</label>
          <textarea value={p.missionDetail} rows={3} maxLength={1200} onChange={(e) => setField("missionDetail", e.target.value)} />
        </div>

        <div className="cpe-sub">Content sections (up to 6 — product, culture, tech, anything)</div>
        {p.sections.map((sec, i) => (
          <div key={i} className="cpe-block">
            <div className="cpe-cardrow">
              <input value={sec.title} maxLength={80} placeholder="Section title" onChange={(e) => setSection(i, { title: e.target.value })} />
              <input value={sec.subtitle} maxLength={160} placeholder="Subtitle (optional)" onChange={(e) => setSection(i, { subtitle: e.target.value })} />
            </div>
            <textarea value={sec.body} rows={3} maxLength={2000} placeholder="Body text" onChange={(e) => setSection(i, { body: e.target.value })} />
            <button type="button" className="cpe-x cpe-block-x" title="Remove section"
              onClick={() => setP((cur) => (cur ? { ...cur, sections: cur.sections.filter((_, j) => j !== i) } : cur))}>
              ✕ Remove section
            </button>
          </div>
        ))}
        {p.sections.length < 6 && (
          <button type="button" className="cpe-add"
            onClick={() => setP((cur) => (cur ? { ...cur, sections: [...cur.sections, { title: "", subtitle: "", body: "" }] } : cur))}>
            + Add a section
          </button>
        )}

        <div className="cpe-sub">Founders (up to 6; the grid sizes itself)</div>
        {p.founders.map((f) => (
          <div key={f.id} className="cpe-founder">
            {f.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="cpe-fphoto" src={f.photoUrl} alt={f.name} />
            ) : (
              <button type="button" className="cpe-fphoto cpe-fphoto-fb" title="Upload photo"
                onClick={() => { founderTarget.current = f.id; founderRef.current?.click(); }}>
                {f.name ? initials(f.name) : "+"}
              </button>
            )}
            <div className="cpe-fcols">
              <div className="cpe-cardrow">
                <input value={f.name} maxLength={120} placeholder="Name" onChange={(e) => setFounder(f.id, { name: e.target.value })} />
                <input value={f.title} maxLength={80} placeholder="Title (Co-founder · CEO)" onChange={(e) => setFounder(f.id, { title: e.target.value })} />
              </div>
              <textarea value={f.bio} rows={2} maxLength={600} placeholder="Short bio" onChange={(e) => setFounder(f.id, { bio: e.target.value })} />
              <div className="cpe-cardrow">
                <input value={f.linkedin} maxLength={300} placeholder="LinkedIn URL" onChange={(e) => setFounder(f.id, { linkedin: e.target.value })} />
                <button className="dash-btn dash-btn-2" disabled={uploading === f.id}
                  onClick={() => { founderTarget.current = f.id; founderRef.current?.click(); }}>
                  {uploading === f.id ? "Uploading…" : f.photoUrl ? "Change photo" : "Upload photo"}
                </button>
              </div>
            </div>
            <button type="button" className="cpe-x" title="Remove founder"
              onClick={() => setP((cur) => (cur ? { ...cur, founders: cur.founders.filter((x) => x.id !== f.id) } : cur))}>
              ✕
            </button>
          </div>
        ))}
        {p.founders.length < 6 && (
          <button type="button" className="cpe-add"
            onClick={() => setP((cur) => (cur ? { ...cur, founders: [...cur.founders, { id: rid("f"), name: "", title: "", bio: "", linkedin: "", photoPath: null, photoUrl: null }] } : cur))}>
            + Add a founder
          </button>
        )}
        <input
          ref={founderRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && founderTarget.current) upload(f, "founder", founderTarget.current);
            e.target.value = "";
          }}
        />

        <div className="cpe-sub">Interview rounds (up to 8 — shown as rows with a click-down drawer)</div>
        {p.rounds.map((r) => (
          <div key={r.id} className="cpe-block">
            <div className="cpe-cardrow">
              <input value={r.name} maxLength={60} placeholder="Round name" onChange={(e) => setRound(r.id, { name: e.target.value })} />
              <input value={r.duration} maxLength={30} placeholder="Duration (30 min, Half day…)" onChange={(e) => setRound(r.id, { duration: e.target.value })} />
            </div>
            <input value={r.hint} maxLength={120} placeholder="One-line hint shown in the row" onChange={(e) => setRound(r.id, { hint: e.target.value })} className="cpe-wide" />
            <textarea value={r.detail} rows={2} maxLength={800} placeholder="Full detail shown when the row is opened" onChange={(e) => setRound(r.id, { detail: e.target.value })} />
            <button type="button" className="cpe-x cpe-block-x" title="Remove round"
              onClick={() => setP((cur) => (cur ? { ...cur, rounds: cur.rounds.filter((x) => x.id !== r.id) } : cur))}>
              ✕ Remove round
            </button>
          </div>
        ))}
        {p.rounds.length < 8 && (
          <button type="button" className="cpe-add"
            onClick={() => setP((cur) => (cur ? { ...cur, rounds: [...cur.rounds, { id: rid("r"), name: "", duration: "", hint: "", detail: "" }] } : cur))}>
            + Add a round
          </button>
        )}
        <div className="dash-field"><label>Process note (closing line under the rounds)</label>
          <input value={p.processNote} maxLength={300} placeholder="We give feedback after every round…" onChange={(e) => setField("processNote", e.target.value)} />
        </div>

        <div className="dash-formfoot" style={{ marginTop: 14 }}>
          <button className="dash-btn" disabled={saving} onClick={() => save()}>
            {saving ? "Saving…" : "Save"}
          </button>
          {published ? (
            <>
              <span className="dash-mypage-live">● Published</span>
              <button className="dash-btn dash-btn-2" disabled={saving} onClick={() => save(false)}>
                Unpublish
              </button>
            </>
          ) : (
            <button className="dash-btn dash-btn-2" disabled={saving} onClick={() => save(true)}>
              Save &amp; publish
            </button>
          )}
          {saved && !error && <span className="dash-saved">Saved ✓</span>}
        </div>
        {error && <p className="dash-error">{error}</p>}
      </div>
    </div>
  );
}
