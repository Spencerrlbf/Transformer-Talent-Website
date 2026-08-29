import Link from "next/link";
import { PLACEMENTS } from "@/data/placements";
import { getRoles } from "@/lib/roles";
import marketData from "@/data/market-index.json";
import SalaryChart from "@/components/SalaryChart";

export const revalidate = 3600;

// The chosen "two doors" homepage (Agency Home, 11a): centered hero with the
// existing claim verbatim, one card per audience, the five real placements,
// How it works beside the market-index teaser, then the dark JD band. The
// old terminal-window hero is deliberately dropped.
export default async function Home() {
  const roles = await getRoles();
  const searches = (marketData as { roles: number }[]).reduce((s, b) => s + b.roles, 0);

  return (
    <main className="mk-home">
      <section className="mk-hero">
        <h1 className="h-display">
          Top engineers. The best-backed
          <br />
          <span>start-ups.</span>
        </h1>
        <p className="mk-sub">
          Transformer Talent specialises in placing <b>top AI/ML and software
          engineers</b> at venture-backed start-ups, from first engineering
          hire to Chief Science Officer.
        </p>
        <p className="mk-eyebrow">
          Placements at companies backed by{" "}
          <b>Sequoia · 8VC · Felicis · Y Combinator · a16z</b>
        </p>
      </section>

      <section className="mk-band">
        <div className="wrap">
          <div className="mk-doors">
            <div className="mk-door">
              <span className="mk-kick">Hiring managers</span>
              <h2>Upload your JD. See who we&apos;d put in front of you.</h2>
              <p>
                Anonymized profiles from our network, and an honest read on
                whether your band clears the market, from {searches} live
                searches. No call required.
              </p>
              <div className="acts">
                <Link className="btn" href="/talent">
                  Upload your JD →
                </Link>
                <a className="mk-textlink" href="#how">
                  How it works
                </a>
              </div>
            </div>
            <div className="mk-door alt">
              <span className="mk-kick">Engineers</span>
              <h2>One profile, every role we work on.</h2>
              <p>
                Most of what we place is never posted publicly. Apply once and
                we&apos;ll consider you for all of it, now and as new searches
                open.
              </p>
              <div className="acts">
                <Link className="btn cold" href="/roles">
                  See {roles.length} open roles →
                </Link>
                <Link className="mk-textlink" href="/apply?speculative=1">
                  Send a resume
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mk-band">
        <div className="wrap">
          <div className="mk-headrow">
            <h2 className="mk-h2">Recently closed</h2>
            <span className="mk-headsub">ML infrastructure through Chief Science Officer</span>
          </div>
          <div className="mk-placements">
            {PLACEMENTS.map((p) => (
              <a key={p.company} className="mk-placement" href={p.url} target="_blank" rel="noreferrer">
                <span className="co">
                  {p.company} <i>↗</i>
                </span>
                <span className="role">{p.role}</span>
                <span className="line">{p.line}</span>
                <span className="tag">{p.tag}</span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="mk-band" id="how">
        <div className="wrap">
          <div className="mk-duo">
            <div>
              <span className="mk-kick">How it works</span>
              <div className="mk-steps">
                <div className="mk-step">
                  <span className="n">1</span>
                  <div>
                    <b>You send a JD, or a profile.</b>
                    <p>Paste it or upload a PDF.</p>
                  </div>
                </div>
                <div className="mk-step">
                  <span className="n">2</span>
                  <div>
                    <b>We come back within 48 hours.</b>
                    <p>
                      Anonymized profiles of engineers we&apos;d put in front
                      of you, each with a plain-English reason, plus whether
                      the band clears the market.
                    </p>
                  </div>
                </div>
                <div className="mk-step">
                  <span className="n">3</span>
                  <div>
                    <b>You decide if it&apos;s worth a conversation.</b>
                    <p>
                      Every engineer we send has been screened and reviewed.
                      If none of them are right, we say so.
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <div>
              <span className="mk-kick">Market index</span>
              <h3 className="mk-h3">What engineers actually cost.</h3>
              <p className="mk-teaser-sub">
                Median authorized base bands from {searches} live searches,
                not scraped posts, not survey self-reports.
              </p>
              <div className="mk-teaser">
                <SalaryChart compact />
              </div>
              <Link className="mk-textlink" href="/market-index">
                See the full index →
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mk-cta">
        <div className="wrap mk-cta-in">
          <div>
            <h2>
              Upload your JD. <span>We&apos;ll share potential matches.</span>
            </h2>
            <p>
              Paste a job description and see anonymized profiles of engineers
              we&apos;d put in front of you — before you ever take a call.
            </p>
          </div>
          <Link className="btn" href="/talent">
            SEE POTENTIAL MATCHES →
          </Link>
        </div>
      </section>
    </main>
  );
}
