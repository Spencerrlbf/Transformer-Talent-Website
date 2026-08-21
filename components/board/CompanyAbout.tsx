"use client";
// The company page proper: the About tab on a tenant board. Every section
// renders only when its content exists. Facts live in the identity strip
// (BoardClient); this component is the story: mission, free-form sections,
// founders, and the interview rounds with click-down drawers.
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

  return (
    <div className="coab">
      {(p.missionHeadline || p.missionDetail) && (
        <div className="coab-mission">
          <div className="coab-eyebrow">Our mission</div>
          {p.missionHeadline && <p className="coab-lead">{p.missionHeadline}</p>}
          {p.missionDetail && <p className="coab-sub">{p.missionDetail}</p>}
        </div>
      )}

      {p.sections.map((sec, i) => (
        <div key={i} className="coab-sec">
          <h2>{sec.title}</h2>
          {sec.subtitle && <div className="coab-subtitle">{sec.subtitle}</div>}
          <p>{sec.body}</p>
        </div>
      ))}

      {p.founders.length > 0 && (
        <div className="coab-sec">
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
        <div className="coab-sec">
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
  );
}
