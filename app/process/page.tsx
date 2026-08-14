import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Process",
  description:
    "How a Transformer Talent search works: brief, machine-assisted matching, 48-hour shortlist, managed close. Contingent and retained engagements.",
};

export default function ProcessPage() {
  return (
    <main className="page">
      <div className="wrap">
        <h1 className="h-page b1">
          How a search <span>runs</span>
        </h1>
        <p className="page-intro b2">
          One principal, one matching engine, one accountable process. Most
          searches go from brief to accepted offer in <b>3–6 weeks</b>.
        </p>

        <div className="pipeline b3">
          <div className="stage">
            <div className="no">STAGE_01 · DAY 0</div>
            <h4>Brief</h4>
            <p>
              A 30-minute call. We leave knowing what “great” means for this
              role, the real comp band, and the deal-breakers on both sides.
            </p>
          </div>
          <div className="stage">
            <div className="no">STAGE_02 · DAYS 0–2</div>
            <h4>Match</h4>
            <p>
              We match your JD against our network and qualify every
              candidate by hand — motivation, comp, timeline.
            </p>
          </div>
          <div className="stage">
            <div className="no">STAGE_03 · HOUR 48</div>
            <h4>Shortlist</h4>
            <p>
              Interested, comp-aligned engineers with context on each: why
              this person, why now, what they&apos;ll ask you.
            </p>
          </div>
          <div className="stage">
            <div className="no">STAGE_04 · WEEKS 2–6</div>
            <h4>Close</h4>
            <p>
              Interview logistics, references, competing-offer management,
              signature — and I stay through day one.
            </p>
          </div>
        </div>

        <div className="sec-label">
          <b>FAQ</b> — the questions founders actually ask
        </div>
        <div className="faq b4">
          <details>
            <summary>How do fees work?</summary>
            <p className="a">
              Contingent search: a percentage of first-year base, invoiced only
              when your hire signs. Retained engagements are available for
              executive and multi-hire searches. Exact terms on the intro call
              — no surprises, no invoice until there&apos;s a signature unless
              we agree otherwise up front.
            </p>
          </details>
          <details>
            <summary>What&apos;s the guarantee?</summary>
            <p className="a">
              If a placement leaves within the guarantee window, we re-run the
              search at no additional fee. Terms are in every engagement
              letter.
            </p>
          </details>
          <details>
            <summary>How fast is “fast”?</summary>
            <p className="a">
              First shortlist within 48 hours of the brief. Most searches close
              in 3–6 weeks. Our tooling removes the two slowest parts of
              recruiting — finding and filtering — so our time goes into what
              matters: qualifying and closing.
            </p>
          </details>
          <details>
            <summary>What roles do you cover?</summary>
            <p className="a">
              AI/ML engineering and research, infrastructure/backend,
              product/full-stack, and forward-deployed engineering — IC through
              executive (our log includes a Chief Science Officer search). US
              focus, SF and NYC strongest.
            </p>
          </details>
          <details>
            <summary>Where do candidates come from?</summary>
            <p className="a">
              A deep, enriched network built over years of AI/ML search,
              including thousands of engineers in active conversation with us
              right now. Not job boards, not the same LinkedIn search your
              last agency ran.
            </p>
          </details>
          <details>
            <summary>Who actually works my search?</summary>
            <p className="a">
              A senior recruiter, end to end — led by Spencer. No handoff to
              a junior sourcer after the kickoff call.
            </p>
          </details>
        </div>

        <div className="sec-label">
          <b>NEXT</b> — start
        </div>
        <div className="bigcta">
          <h2>
            Upload your <span>JD</span> — or book a <span>brief</span>.
          </h2>
          <p>
            See anonymized potential matches in seconds, or book a 30-minute
            brief and get a shortlist in 48 hours.
          </p>
          <div className="cta-row" style={{ justifyContent: "center" }}>
            <Link className="btn hot" href="/talent">
              SEE POTENTIAL MATCHES →
            </Link>
            <a
              className="btn cold"
              href="mailto:spencer@transformertalent.com?subject=Search%20brief"
            >
              Book the brief
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
