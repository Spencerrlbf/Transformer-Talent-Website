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
              Top engineers.
              <br />
              The best-backed
              <br />
              <span>start-ups.</span>
            </h1>
            <p className="sub b2" style={{ marginTop: "1.8rem" }}>
              Transformer Talent specialises in placing <b>top AI/ML and
              software engineers</b> at venture-backed start-ups, from first
              engineering hire to Chief Science Officer.
            </p>
            <p className="b2" style={{ marginTop: "1.4rem", fontSize: "0.66rem", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--fog-30)" }}>
              Placements at companies backed by{" "}
              <b style={{ color: "var(--fog-60)" }}>Sequoia · 8VC · Felicis · Y Combinator · a16z</b>
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
          <b>001</b> — placements --closed
        </div>
        <div className="marquee-wrap" style={{ display: "block" }}>
          <div className="marquee">
            {[...PLACEMENTS, ...PLACEMENTS, ...PLACEMENTS].map((p, i) => (
              <span key={i} style={{ display: "contents" }}>
                <span className="marquee-item">
                  <span className="co">{p.company}</span>
                  <span className="role">{p.role}</span>
                  <span className="st">CLOSED</span>
                </span>
                <span className="marquee-sep">✦</span>
              </span>
            ))}
          </div>
        </div>

        <div className="sec-label">
          <b>002</b> — match --try
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
