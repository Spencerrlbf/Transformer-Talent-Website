"use client";
// The company page proper: the About tab on a tenant board. Every section
// renders only when its content exists. Facts live in the identity strip
// (BoardClient); this component is the story: mission, free-form sections,
// founders, and the interview rounds with click-down drawers. A sticky
// right-hand rail lists the sections with a reading-progress track: the
// accent bar fills as the visitor scrolls, passed sections fade, the
// current one reads in accent.
import { useEffect, useState } from "react";
import type { CompanyPage } from "@/lib/server/company-page";

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

export default function CompanyAbout({
  company,
  rolesCount,
  onSeeRoles,
}: {
  company: CompanyPage;
  rolesCount: number;
  onSeeRoles: () => void;
}) {
  const p = company.profile;

  // Section index: one rail entry per section that actually exists, so a
  // visitor sees the page's shape at a glance. Rendered only when there are
  // at least two destinations to jump between.
  const anchors: { id: string; label: string }[] = [
    ...(p.missionHeadline || p.missionDetail ? [{ id: "about-mission", label: "Mission" }] : []),
    ...p.sections.map((sec, i) => ({ id: `about-sec-${i}`, label: sec.title || "More" })),
    ...(p.founders.length > 0 ? [{ id: "about-founders", label: "Founders" }] : []),
    ...(p.rounds.length > 0 ? [{ id: "about-hiring", label: "Interview process" }] : []),
  ];
  const anchorKey = anchors.map((a) => a.id).join("|");
  const jump = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Scrollspy + reading progress. The current section is the last one whose
  // top has crossed a line 30% down the viewport; progress maps the scroll
  // position across the span from the first section to the last.
  const [activeId, setActiveId] = useState(anchors[0]?.id ?? "");
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (anchors.length < 2) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const line = window.innerHeight * 0.3;
      let current = anchors[0].id;
      for (const a of anchors) {
        const el = document.getElementById(a.id);
        if (el && el.getBoundingClientRect().top <= line) current = a.id;
      }
      setActiveId(current);
      const first = document.getElementById(anchors[0].id);
      const last = document.getElementById(anchors[anchors.length - 1].id);
      if (first && last) {
        const start = first.getBoundingClientRect().top + window.scrollY - line;
        const end = last.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
        const pct = end > start ? (window.scrollY - start) / (end - start) : 1;
        setProgress(Math.max(0, Math.min(1, pct)));
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey]);

  const activeIndex = anchors.findIndex((a) => a.id === activeId);

  return (
    <div className={anchors.length >= 2 ? "coab-wrap" : undefined}>
    <div className="coab">
      {(p.missionHeadline || p.missionDetail) && (
        <div className="coab-mission" id="about-mission">
          <div className="coab-eyebrow">Our mission</div>
          {p.missionHeadline && <p className="coab-lead">{p.missionHeadline}</p>}
          {p.missionDetail && <p className="coab-sub">{p.missionDetail}</p>}
        </div>
      )}

      {p.sections.map((sec, i) => (
        <div key={i} className="coab-sec" id={`about-sec-${i}`}>
          <h2>{sec.title}</h2>
          {sec.subtitle && <div className="coab-subtitle">{sec.subtitle}</div>}
          <p>{sec.body}</p>
        </div>
      ))}

      {p.founders.length > 0 && (
        <div className="coab-sec" id="about-founders">
          <h2>Founders</h2>
          <div className="coab-founders">
            {p.founders.map((f) => (
              <div key={f.id} className="coab-founder">
                {f.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="coab-fphoto" src={f.photoUrl} alt={f.name} />
                ) : (
                  <div className="coab-fphoto coab-fphoto-fb">{initials(f.name)}</div>
                )}
                <div>
                  <div className="coab-fname">{f.name}</div>
                  {f.title && <div className="coab-ftitle">{f.title}</div>}
                  {f.bio && <p className="coab-fbio">{f.bio}</p>}
                  {f.linkedin && (
                    <a className="coab-fln" href={f.linkedin} target="_blank" rel="noreferrer">
                      in&nbsp; LinkedIn
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {p.rounds.length > 0 && (
        <div className="coab-sec" id="about-hiring">
          <div className="coab-eyebrow">How we hire</div>
          <h2>The rounds we draw from.</h2>
          <p className="coab-hireintro">
            The exact steps vary by role; your recruiter confirms the process up front. Click a
            round for the full detail.
          </p>
          <div className="crd-list">
            {p.rounds.map((r, i) => (
              <details key={r.id} className="crd-row">
                <summary>
                  <span className="crd-num">{i + 1}</span>
                  <b>{r.name}</b>
                  {r.hint && <span className="crd-hint">{r.hint}</span>}
                  {r.duration && <span className="crd-dur">{r.duration}</span>}
                  <span className="crd-car">▶</span>
                </summary>
                {r.detail && (
                  <div className="crd-drawer">
                    <p>{r.detail}</p>
                  </div>
                )}
              </details>
            ))}
          </div>
          {p.processNote && <p className="coab-hireintro coab-pnote">{p.processNote}</p>}
        </div>
      )}

      <div className="coab-cta">
        <div>
          <h3>We&apos;re hiring.</h3>
          <p>
            {rolesCount} open role{rolesCount === 1 ? "" : "s"}, every application reviewed by a
            real recruiter.
          </p>
        </div>
        <button type="button" onClick={onSeeRoles}>
          See {rolesCount} open role{rolesCount === 1 ? "" : "s"} →
        </button>
      </div>
    </div>

    {anchors.length >= 2 && (
      <aside className="coab-rail" aria-label="On this page">
        <div className="coab-track" aria-hidden="true">
          <i style={{ height: `${Math.round(progress * 100)}%` }} />
        </div>
        <nav className="coab-rail-items">
          <span className="coab-rail-kick">On this page</span>
          {anchors.map((a, i) => (
            <button
              key={a.id}
              type="button"
              className={a.id === activeId ? "on" : i < activeIndex ? "past" : ""}
              onClick={() => jump(a.id)}
            >
              {a.label}
            </button>
          ))}
        </nav>
      </aside>
    )}
    </div>
  );
}
