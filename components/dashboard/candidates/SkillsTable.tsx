"use client";
// The skills on the report card, from the jobs they were used on: two
// columns of skill, dated years and where it was used, strongest first.
// Skills the profile lists but never tagged on a dated job close the table
// on one greyed line. Written by code from the job tags and dates.
import type { ProfileFacts } from "@/lib/rolecard";
import { yearsShort, yearsTiny } from "./report-format";

type Skill = NonNullable<ProfileFacts["skills"]>[number];
type Job = ProfileFacts["companies"][number];

const whereWord = (s: Skill) => [...s.where, ...(s.current ? ["now"] : [])].join(", ");

export default function SkillsTable({ skills, companies = [] }: { skills: Skill[]; companies?: Job[] }) {
  const used = skills.filter((s) => !s.listedOnly);
  const listed = skills.filter((s) => s.listedOnly).map((s) => s.name);
  if (!used.length && !listed.length) return <p className="vc-none">No skills tagged on the profile's jobs.</p>;
  // A skill with no dated years was tagged only on an internship or another
  // position that is not a career job (those count for no years), or on a
  // job with no dates.
  const careerAt = new Set(companies.filter((c) => c.career).map((c) => c.name));
  const asideAt = new Set(companies.filter((c) => !c.career).map((c) => c.name));
  const internOnly = (s: Skill) => s.where.length > 0 && s.where.every((w) => asideAt.has(w) && !careerAt.has(w));
  return (
    <ul className="vc-skills" title="Years are added up from the dated jobs each skill is tagged on; a skill on the current job says so">
      {used.map((s, i) => (
        <li key={`${s.name}-${i}`} className="vc-skill">
          <b>{s.name}</b>
          {s.years != null && s.years > 0 ? (
            <span className="y" title={`${yearsShort(s.years)} on dated jobs`}>{yearsTiny(s.years)}</span>
          ) : internOnly(s) ? (
            <span className="y none" title="Tagged only on an internship or another position that is not a career job. Those count for no years.">internship only</span>
          ) : (
            <span className="y none" title="On a job with no dates">undated</span>
          )}
          <span className="w">{whereWord(s) || " "}</span>
        </li>
      ))}
      {listed.length > 0 && (
        <li className="vc-listed" title="On the profile's skills list, never tagged on a dated job">
          Listed only: {listed.join(", ")}
        </li>
      )}
    </ul>
  );
}
