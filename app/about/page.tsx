import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About",
  description:
    "Transformer Talent is a specialist AI/ML and software engineering search firm. Founded by a former software engineer, partnering with venture-backed start-ups from first hire to executive.",
};

export default function AboutPage() {
  return (
    <main className="page">
      <div className="wrap">
        <div className="ab-head">
          <h1 className="h-page">
            How we <span>work</span>
          </h1>
          <p className="page-intro">
            A specialist search firm for teams that treat engineering hiring as
            seriously as engineering itself.
          </p>
        </div>

        <div className="grid2 ab-values">
          <div className="cell">
            <h3>Specialists, not generalists.</h3>
            <p>
              Transformer Talent does one thing: AI/ML and software
              engineering search for venture-backed start-ups. IC to
              executive, first engineering hire to Chief Science Officer.
            </p>
            <p>
              Placements at companies backed by <b>Sequoia, 8VC, Felicis,
              Y&nbsp;Combinator, and a16z</b>.
            </p>
          </div>
          <div className="cell">
            <h3>Partners, not vendors.</h3>
            <p>
              We work as an extension of your team, from brief to signed
              offer. We believe working together is how the best hires get
              made, so we go deep with a handful of companies rather than
              shallow with fifty.
            </p>
            <p>Most of our clients come back for their next hire.</p>
          </div>
          <div className="cell">
            <h3>Technologists at heart.</h3>
            <p>
              Founded by a former software engineer to bridge the gap between
              recruitment and technical understanding. We speak both
              languages, so nothing gets lost between the brief and the
              codebase.
            </p>
            <p>
              Founders get a partner who understands what they are building.
              Engineers get recruiters who can actually explain the stack.
            </p>
          </div>
          <div className="cell">
            <h3>Senior-led, end to end.</h3>
            <p>
              Every search is run by senior recruiters, from the first
              conversation about the brief to the signed offer. No handoff to
              a junior sourcer after the kickoff call.
            </p>
          </div>
        </div>

        <section className="ab-quotes-sec">
          <h2 className="ab-h2">What clients say</h2>
          <div className="grid2 ab-quotes">
            <div className="qcard">
              <div className="qmark" aria-hidden>
                &ldquo;
              </div>
              <blockquote>
                Five key hires over the last two years. We now only work with
                Transformer Talent.
              </blockquote>
              <div className="qattr">CTO · Series B Fintech</div>
            </div>
            <div className="qcard">
              <div className="qmark" aria-hidden>
                &ldquo;
              </div>
              <blockquote>
                The only recruiters we&apos;ve used who actually understood the
                role before sending profiles.
              </blockquote>
              <div className="qattr">Founder · Applied AI, Seed</div>
            </div>
          </div>
        </section>

        <div className="ab-cta">
          <div className="ab-cta-copy">
            <h2>
              Hiring engineers? Let&apos;s <span>talk.</span>
            </h2>
            <p>
              Upload a job description for instant potential matches, or email
              us and we&apos;ll take it from there.
            </p>
          </div>
          <div className="ab-cta-row">
            <Link className="ab-cta-btn" href="/talent">
              SEE POTENTIAL MATCHES →
            </Link>
            <a className="ab-cta-cold" href="mailto:spencer@transformertalent.com">
              spencer@transformertalent.com
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
