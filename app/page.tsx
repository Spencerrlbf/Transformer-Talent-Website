import Link from "next/link";
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
              We find the
              <br />
              engineers who
              <br />
              <span>build the future.</span>
            </h1>
            <p className="sub b2" style={{ marginTop: "1.8rem" }}>
              Transformer Talent places <b>AI/ML and software engineers</b>{" "}
              with startups backed by <b>Sequoia, 8VC, and Felicis</b> — from
              first engineering hire to Chief Science Officer.
            </p>
            <div className="cta-row b3" style={{ marginTop: "2.4rem" }}>
              <Link className="btn hot" href="/talent">
                Hiring? Upload your JD
              </Link>
              <Link className="btn cold" href="/roles">
                Looking? See open roles
              </Link>
            </div>
          </div>
          <div className="term b3">
            <div className="term-head">
              <span className="dot r" />
              <span className="dot y" />
              <span className="dot g" />
            </div>
            <div className="term-body" style={{ minHeight: 0, padding: "2rem 1.6rem" }}>
              <div className="c"># hiring managers</div>
              <div style={{ margin: "0.4rem 0 1.2rem" }}>
                Upload your job description and we&apos;ll share a few
                potential matches from our network — anonymized, no call
                required.
              </div>
              <div className="c"># engineers</div>
              <div style={{ margin: "0.4rem 0 1.4rem" }}>
                One profile, every role we work on — most are never posted
                publicly.
              </div>
              <div>
                <span className="p">→</span>{" "}
                <Link href="/talent" style={{ color: "var(--signal)" }}>
                  see potential matches
                </Link>{" "}
                <span className="c">·</span>{" "}
                <Link href="/roles" style={{ color: "var(--signal)" }}>
                  browse roles
                </Link>
              </div>
            </div>
          </div>
        </section>

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
          <b>002</b> — team --info
        </div>
        <div className="grid2">
          <div className="cell">
            <div className="op-photo">
              <span className="placeholder">[ IMG — TEAM ]</span>
            </div>
            <dl className="kv">
              <dt>FIRM</dt>
              <dd>Transformer Talent</dd>
              <dt>MODEL</dt>
              <dd>Senior recruiters, end to end</dd>
              <dt>BASE</dt>
              <dd>San Francisco / New York</dd>
              <dt>FOCUS</dt>
              <dd>AI/ML &amp; software engineering</dd>
            </dl>
          </div>
          <div className="cell">
            <h3>
              A search firm that
              <br />
              <span>works like a team.</span>
            </h3>
            <p>
              Every search gets a senior recruiter who takes the brief, makes
              the calls, and manages the close — backed by a team and tooling
              that keep the pipeline moving while you sleep.
            </p>
            <p>
              Clients get one accountable point of contact. Candidates get
              recruiters who can actually explain the tech stack. Searches
              close in weeks, not quarters.
            </p>
            <Link className="btn cold" href="/process" style={{ marginTop: "0.4rem" }}>
              How a search works →
            </Link>
          </div>
        </div>

        <div className="sec-label">
          <b>003</b> — match --try
        </div>
        <div className="bigcta">
          <h2>
            Upload your JD. <span>We&apos;ll share potential matches.</span>
          </h2>
          <p>
            Paste a job description and see anonymized profiles of engineers
            we&apos;d put in front of you — before you ever take a call.
          </p>
          <Link className="btn hot" href="/talent">
            SEE POTENTIAL MATCHES →
          </Link>
        </div>
      </div>
    </main>
  );
}
