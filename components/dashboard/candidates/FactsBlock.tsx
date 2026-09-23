"use client";
// The facts block at the top right of the report card: six label and value
// lines about the person, worked out in code from the dated positions, the
// current title, the employer's own page and the education list. Never a
// model's reading. Older saved reviews may lack the seniority line's data
// and say so.
import type { ProfileFacts } from "@/lib/rolecard";
import { capitalise, companySize, degreeShort, plural, yearsWord } from "./report-format";

export default function FactsBlock({ p }: { p: ProfileFacts }) {
  const cur = p.current;
  // The years the role's bar is about lead: engineering years on an
  // engineering role, the career on any other (a data science or product
  // role), so the block says what the years row says.
  const career = p.basis === "career" || (p.engineeringYears == null && p.careerYears != null);
  const lead = career ? p.careerYears : p.engineeringYears;
  const inAll = !career && p.careerYears != null && p.engineeringYears != null && p.careerYears - p.engineeringYears >= 0.5 ? `${yearsWord(p.careerYears)} in all` : "";
  const size = companySize(cur);
  const sen = p.seniority;
  return (
    <dl className="vc-factsblock" title="Facts, not the AI's reading: worked out in code from the dated positions and the title on the profile, plus the employer's own company page">
      <dt>Title</dt>
      {cur?.title ? <dd>{cur.title}</dd> : <dd className="none">{cur?.company ? "No title listed" : "No current position"}</dd>}

      <dt>Company</dt>
      {cur?.company ? (
        <dd>
          {cur.company}
          {size && <small title={cur.founded ? `Founded ${cur.founded}, from the company's own page` : "From the company's own page"}> · {size}</small>}
        </dd>
      ) : (
        <dd className="none">None listed</dd>
      )}

      <dt>School</dt>
      {p.school ? (
        <dd>
          {p.school.name}
          {degreeShort(p.school.degree) && `, ${degreeShort(p.school.degree)}`}
          {(p.school.field || p.school.year) && <small> · {[p.school.field, p.school.year].filter(Boolean).join(" · ")}</small>}
        </dd>
      ) : (
        <dd className="none">None listed</dd>
      )}

      <dt>Experience</dt>
      {lead != null ? (
        <dd>
          {yearsWord(lead)}
          <small>
            {" "}
            {[career ? "of career" : "engineering", p.careerSince ? `since ${p.careerSince}` : "", inAll].filter(Boolean).join(", ")}
          </small>
        </dd>
      ) : (
        <dd className="none">Not dated</dd>
      )}

      <dt>Seniority</dt>
      {sen ? (
        sen.level ? (
          <dd>
            {capitalise(sen.level)}
            {sen.note && <small> · {sen.note}</small>}
          </dd>
        ) : (
          <dd className="none">{sen.note || "Not read from the title"}</dd>
        )
      ) : (
        <dd className="none" title="Read from the current title on newer reviews. Review again to fill it in.">Not on file</dd>
      )}

      <dt>Avg tenure</dt>
      {p.avgTenureYears != null ? (
        <dd>
          {yearsWord(p.avgTenureYears)}
          <small> · {plural(p.careerJobs, "job")}</small>
        </dd>
      ) : (
        <dd className="none">Not dated</dd>
      )}
    </dl>
  );
}
