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
        <h1 className="h-page b1">
          How we <span>work</span>
        </h1>
        <p className="page-intro b2">
          A specialist search firm for teams that treat engineering hiring as
          seriously as engineering itself.
        </p>

        <div className="grid2 b3">
          <div className="cell">
            <h3>
              Specialists,
              <br />
              <span>not generalists.</span>
            </h3>
            <p>
              Transformer Talent does one thing: AI/ML and software
              engineering search for venture-backed start-ups. IC to
              executive, first engineering hire to Chief Science Officer.
            </p>
            <p>
              Placements at companies backed by <b>Sequoia, 8VC, Felicis,
              Y Combinator, and a16z</b>.
            </p>
          </div>
          <div className="cell">
            <h3>
              Partners,
              <br />
              <span>not vendors.</span>
            </h3>
            <p>
              We work as an extension of your team, from brief to signed
              offer. We believe working together is how the best hires get
              made, so we go deep with a handful of companies rather than
              shallow with fifty.
            </p>
            <p>Most of our clients come back for their next hire.</p>
          </div>
        </div>

        <div className="grid2">
          <div className="cell">
            <h3>
              Technologists
              <br />
              <span>at heart.</span>
            </h3>
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
            <h3>
              Senior-led,
              <br />
              <span>end to end.</span>
            </h3>
            <p>
              Every search is run by senior recruiters, from the first
              conversation about the brief to the signed offer. No handoff to
              a junior sourcer after the kickoff call.
            </p>
          </div>
        </div>

        <div className="sec-label">
          <b>REF</b> — what clients say
        </div>
        <div className="grid2">
          <div className="cell">
            <p style={{ fontSize: "1rem", color: "var(--fog)" }}>
              &ldquo;Five key hires over the last two years. We now only work with
              Transformer Talent.&rdquo;
            </p>
            <p style={{ fontSize: "0.68rem", color: "var(--fog-30)", textTransform: "uppercase", letterSpacing: "0.14em" }}>
              CTO · Series B Fintech
            </p>
          </div>
          <div className="cell">
            <p style={{ fontSize: "1rem", color: "var(--fog)" }}>
              &ldquo;The only recruiters we&apos;ve used who actually understood the
              role before sending profiles.&rdquo;
            </p>
            <p style={{ fontSize: "0.68rem", color: "var(--fog-30)", textTransform: "uppercase", letterSpacing: "0.14em" }}>
              Founder · Applied AI, Seed
            </p>
          </div>
        </div>

        <div className="sec-label">
          <b>NEXT</b> — talk to us
        </div>
        <div className="bigcta">
          <h2>
            Hiring engineers? <span>Let&apos;s talk.</span>
          </h2>
          <p>
            Upload a job description for instant potential matches, or email
            us and we&apos;ll take it from there.
          </p>
          <div className="cta-row" style={{ marginTop: "1.4rem" }}>
            <Link className="btn hot" href="/talent">
              SEE POTENTIAL MATCHES →
            </Link>
            <a className="btn cold" href="mailto:spencer@transformertalent.com">
              spencer@transformertalent.com
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
