import Link from "next/link";
import TerminalHero from "@/components/TerminalHero";
import { PLACEMENTS } from "@/data/placements";

const heroGrid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
  gap: "4rem",
  padding: "5rem 0 4rem",
  alignItems: "center",
};

export default function Home() {
  return (
    <main className="page" style={{ paddingTop: 0 }}>
      <div className="wrap">
        <section style={heroGrid}>
          <div>
            <h1 className="h-display b1">
              Recruiting at
              <br />
              machine speed.
              <br />
              <span>Closed by a human.</span>
            </h1>
            <p className="sub b2" style={{ marginTop: "1.8rem" }}>
              Transformer Talent pairs a <b>419,000-profile matching engine</b>{" "}
              with a principal who runs every search personally. AI/ML and
              software engineers, placed at startups backed by{" "}
              <b>Sequoia, 8VC, and Felicis</b>.
            </p>
            <div className="cta-row b3" style={{ marginTop: "2.4rem" }}>
              <Link className="btn hot" href="/talent">
                Run a match on your JD
              </Link>
              <Link className="btn cold" href="/process">
                Begin a search
              </Link>
            </div>
          </div>
          <TerminalHero />
        </section>

        <div className="ticker b4">
          <div className="tick">
            <div className="n">419,595</div>
            <div className="l">Profiles indexed</div>
          </div>
          <div className="tick">
            <div className="n">
              0.6<i>s</i>
            </div>
            <div className="l">Vector search</div>
          </div>
          <div className="tick">
            <div className="n">
              22.6<i>k</i>
            </div>
            <div className="l">In active conversation</div>
          </div>
          <div className="tick">
            <div className="n">
              48<i>h</i>
            </div>
            <div className="l">To first shortlist</div>
          </div>
        </div>

        <div className="sec-label">
          <b>001</b> — placement_log --recent
        </div>
        <div className="logs">
          {PLACEMENTS.map((p, i) => (
            <Link key={p.company} href="/placements" className="log">
              <span className="t">LOG_{String(i + 1).padStart(2, "0")}</span>
              <span className="co">{p.company}</span>
              <span className="role">{p.role}</span>
              <span className="st">CLOSED</span>
            </Link>
          ))}
        </div>

        <div className="sec-label">
          <b>002</b> — operator --info
        </div>
        <div className="grid2">
          <div className="cell">
            <div className="op-photo">
              <span className="placeholder">[ IMG — SPENCER ]</span>
            </div>
            <dl className="kv">
              <dt>OPERATOR</dt>
              <dd>Spencer</dd>
              <dt>ROLE</dt>
              <dd>Principal — runs every search</dd>
              <dt>BASE</dt>
              <dd>San Francisco / New York</dd>
              <dt>FOCUS</dt>
              <dd>AI/ML &amp; software engineering</dd>
            </dl>
          </div>
          <div className="cell">
            <h3>
              The machine finds them.
              <br />
              <span>I close them.</span>
            </h3>
            <p>
              Software reads 419,000 profiles in under a second — but no
              engineer ever accepted an offer from a database. Every search
              here is run personally: I take the brief, I make the calls, I
              manage the close.
            </p>
            <p>
              Clients get one point of contact with full context. Candidates
              get a recruiter who can actually explain the tech stack. Searches
              close in weeks, not quarters.
            </p>
            <Link className="btn cold" href="/process" style={{ marginTop: "0.4rem" }}>
              How a search works →
            </Link>
          </div>
        </div>

        <div className="sec-label">
          <b>003</b> — process --pipeline
        </div>
        <div className="pipeline">
          <div className="stage">
            <div className="no">STAGE_01</div>
            <h4>Brief</h4>
            <p>30 minutes. Role, bar, comp band, deal-breakers.</p>
          </div>
          <div className="stage">
            <div className="no">STAGE_02</div>
            <h4>Match</h4>
            <p>The engine surfaces candidates; every one qualified by hand.</p>
          </div>
          <div className="stage">
            <div className="no">STAGE_03</div>
            <h4>Shortlist</h4>
            <p>Interested, comp-aligned engineers within 48 hours.</p>
          </div>
          <div className="stage">
            <div className="no">STAGE_04</div>
            <h4>Close</h4>
            <p>References, competing offers, signature — through day one.</p>
          </div>
        </div>

        <div className="sec-label">
          <b>004</b> — match --public
        </div>
        <div className="bigcta">
          <h2>
            Paste a JD. Get <span>5 matches</span> in 10 seconds.
          </h2>
          <p>
            The same engine that powers our searches, open to you. Anonymized
            profiles from 419,000 engineers — see the quality before you ever
            take a call.
          </p>
          <Link className="btn hot" href="/talent">
            RUN MATCH →
          </Link>
        </div>
      </div>
    </main>
  );
}
