"use client";
// The company page proper: the About tab on a tenant board. Every section
// renders only when its content exists, so a half-filled profile still
// reads as a finished page. Interview steps come from the org's stage
// template; durations and the note are page content.
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
  const stats = [
    p.headcount && { v: p.headcount, l: "People" },
    p.founded && { v: p.founded, l: "Founded" },
    p.stage && { v: p.stage, l: "Stage" },
    p.offices && { v: p.offices, l: "Offices" },
  ].filter(Boolean) as { v: string; l: string }[];

  return (
    <div className="coab">
      {(p.missionHeadline || p.missionDetail) && (
        <div className="coab-mission">
          <div className="coab-eyebrow">Our mission</div>
          {p.missionHeadline && <p className="coab-lead">{p.missionHeadline}</p>}
          {p.missionDetail && <p className="coab-sub">{p.missionDetail}</p>}
        </div>
      )}

      {stats.length > 0 && (
        <div className="coab-stats" style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
          {stats.map((st) => (
            <div key={st.l} className="coab-stat">
              <b>{st.v}</b>
              <span>{st.l}</span>
            </div>
          ))}
        </div>
      )}

      {(p.buildingHeadline || p.buildingDetail || p.buildingCards.length > 0) && (
        <div className="coab-sec">
          <div className="coab-eyebrow">What we&apos;re building</div>
          {p.buildingHeadline && <h2>{p.buildingHeadline}</h2>}
          {p.buildingDetail && <p>{p.buildingDetail}</p>}
          {p.buildingCards.length > 0 && (
            <div className="coab-problems">
              {p.buildingCards.map((c, i) => (
                <div key={i} className="coab-problem">
                  <b>{c.title}</b>
                  <p>{c.text}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {p.founders.length > 0 && (
        <div className="coab-sec">
          <div className="coab-eyebrow">Founders</div>
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

      {company.stages.length > 0 && (
        <div className="coab-sec">
          <div className="coab-eyebrow">How we hire</div>
          <h2>
            {company.stages.length} step{company.stages.length === 1 ? "" : "s"} from first
            conversation to offer.
          </h2>
          <div className="coab-process">
            {company.stages.map((s, i) => (
              <div key={s.id} className="coab-pstep">
                <span className="coab-pdot">{i + 1}</span>
                <div className="coab-pname">{s.label}</div>
                {p.stepDurations[s.id] && (
                  <div className="coab-psub">{p.stepDurations[s.id]}</div>
                )}
              </div>
            ))}
          </div>
          {p.processNote && <p className="coab-pnote">{p.processNote}</p>}
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
