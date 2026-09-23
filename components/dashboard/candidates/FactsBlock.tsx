"use client";
// The facts block at the top right of the report card: six label and value
// lines about the person, worked out in code from the dated positions, the
// current title, the employer's own page and the education list. Never a
// model's reading. Anything the profile does not carry reads "Not on file",
// with the reason in its tooltip. Older saved reviews may lack the seniority
// line's data and the second degree, and say so.
import type { ProfileFacts } from "@/lib/rolecard";
import { capitalise, companySize, degreeShort, plural, yearsWord } from "./report-format";

const NONE = "Not on file";

/** "University of Michigan, BS · Computer Science · 2023" */
function schoolLine(s: NonNullable<ProfileFacts["school"]>) {
  const short = degreeShort(s.degree);
  return (
    <>
      {s.name}
      {short && `, ${short}`}
      {(s.field || s.year) && <small> · {[s.field, s.year].filter(Boolean).join(" · ")}</small>}
    </>
  );
}

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
      {cur?.title ? (
        <dd>{cur.title}</dd>
      ) : (
        <dd className="none" title={cur?.company ? "The current position has no title on the profile" : "No current position on the profile"}>
          {NONE}
        </dd>
      )}

      <dt>Company</dt>
      {cur?.company ? (
        <dd>
          {cur.company}
          {size && <small title={cur.founded ? `Founded ${cur.founded}, from the company's own page` : "From the company's own page"}> · {size}</small>}
        </dd>
      ) : (
        <dd className="none" title="No current position on the profile">
          {NONE}
        </dd>
      )}

      <dt>School</dt>
      {p.school ? (
        <dd>
          {schoolLine(p.school)}
          {p.school2 && (
            <small className="vc-school2" title="Their other degree">
              {schoolLine(p.school2)}
            </small>
          )}
        </dd>
      ) : (
        <dd className="none" title="No education on the profile">
          {NONE}
        </dd>
      )}

      <dt>Experience</dt>
      {lead != null ? (
        <dd>
          {yearsWord(lead)}
          <small>, {[career ? "career" : "engineering", p.careerSince ? `since ${p.careerSince}` : "", inAll].filter(Boolean).join(", ")}</small>
        </dd>
      ) : (
        <dd className="none" title="No dated positions on the profile">
          {NONE}
        </dd>
      )}

      <dt>Seniority</dt>
      {sen ? (
        sen.level ? (
          <dd>
            {capitalise(sen.level)}
            {sen.note && <small> · {capitalise(sen.note)}</small>}
          </dd>
        ) : (
          <dd className="none" title="The current title does not say">
            {sen.note ? capitalise(sen.note) : NONE}
          </dd>
        )
      ) : (
        <dd className="none" title="Read from the current title on newer reviews. Review again to fill it in.">
          {NONE}
        </dd>
      )}

      <dt>Avg tenure</dt>
      {p.avgTenureYears != null ? (
        <dd>
          {yearsWord(p.avgTenureYears)}
          <small> · {plural(p.careerJobs, "job")}</small>
        </dd>
      ) : (
        <dd className="none" title="No dated career positions on the profile">
          {NONE}
        </dd>
      )}
    </dl>
  );
}
