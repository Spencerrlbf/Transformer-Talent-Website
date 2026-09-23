"use client";
// The career on the report card: one row per career job, current first,
// with a bar as long as the job was, the company and its size where the
// employer's page gave one, the dates, the title and the skills tagged on
// that job. Internships and other non-career positions sit greyed on one
// line at the end. All of it comes from the dated positions on the profile.
import type { ProfileFacts } from "@/lib/rolecard";
import { companySize, stillThere, yearOf, yearsShort } from "./report-format";

type Job = ProfileFacts["companies"][number];

const MAX_SKILLS = 8;

export default function CareerList({ p }: { p: ProfileFacts }) {
  const jobs = p.companies.filter((c) => c.career);
  const asides = p.companies.filter((c) => !c.career);
  if (!jobs.length && !asides.length) return <p className="vc-none">No dated positions on the profile.</p>;
  const longest = Math.max(0.1, ...jobs.map((c) => c.years ?? 0));
  const isNow = (c: Job, i: number) => i === 0 && stillThere(c.to) && (!p.current?.company || p.current.company === c.name);
  return (
    <ol className="vc-career" title="The dated career positions on the profile, current first. The bar is as long as the job was.">
      {jobs.map((c, i) => {
        const now = isNow(c, i);
        const size = now ? companySize(p.current) : "";
        const width = c.years != null ? Math.max(10, Math.round((c.years / longest) * 100)) : 10;
        const dates = [c.from && c.to ? `${c.from} to ${stillThere(c.to) ? "now" : c.to}` : c.from ? `${c.from} to now` : "", c.years != null ? yearsShort(c.years) : ""].filter(Boolean).join(" · ");
        const skills = (c.skills || []).slice(0, MAX_SKILLS);
        return (
          <li key={i} className={`vc-job${now ? " now" : ""}`}>
            <span className="vc-bar" style={{ width: `${width}%` }} aria-hidden="true" title={c.years != null ? yearsShort(c.years) : undefined} />
            <div className="vc-job-body">
              <div className="vc-job-h">
                <b>{c.name}</b>
                {size ? <span className="vc-size"> · {size}</span> : <span className="vc-size faint"> · size not on file</span>}
                {dates && <span className="vc-job-d">{dates}</span>}
              </div>
              <div className="vc-job-t">
                {c.title}
                {skills.length > 0 && <span className="vc-job-sk"> · {skills.join(", ")}</span>}
              </div>
            </div>
          </li>
        );
      })}
      {asides.length > 0 && (
        <li className="vc-asides" title="Internships and other positions that are not career jobs. They do not count towards the years.">
          <span className="vc-bar" aria-hidden="true" />
          <div>
            {asides.map((a, i) => (
              <span key={i} className="vc-aside">
                {i > 0 && <span className="vc-aside-sep" aria-hidden="true">·</span>}
                {[a.name, a.title, yearOf(a.from, a.to)].filter(Boolean).join(" · ")}
              </span>
            ))}
          </div>
        </li>
      )}
    </ol>
  );
}
