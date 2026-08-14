import type { Metadata } from "next";
import Link from "next/link";
import { PLACEMENTS } from "@/data/placements";

export const metadata: Metadata = {
  title: "Placements",
  description:
    "Selected placements: ML Infrastructure at Fleet AI, Chief Science Officer at Ironsite, Product Engineer at Adaptive, Forward Deployed Engineers at Palantir.",
};

export default function PlacementsPage() {
  return (
    <main className="page">
      <div className="wrap">
        <h1 className="h-page b1">
          Placement <span>log</span>
        </h1>
        <p className="page-intro b2">
          Selected searches, closed. Placements at companies backed by{" "}
          <b>Sequoia, 8VC, Felicis, Y Combinator, and a16z</b> — from first
          engineering hire to executive science leadership.
        </p>

        <div className="match-grid b3">
          {PLACEMENTS.map((p, i) => (
            <div key={p.company} className="match-card">
              <div className="ref-row">
                <span className="ref">LOG_{String(i + 1).padStart(2, "0")}</span>
                <span className="score">✓ CLOSED</span>
              </div>
              <h4>{p.company}</h4>
              <div className="meta">{p.role}</div>
              <p className="prev">{p.line}</p>
              <div className="tags">
                <span className="tag">{p.tag}</span>
                <a
                  className="tag"
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "none" }}
                >
                  {p.url.replace(/https?:\/\/(www\.)?/, "").replace(/\/$/, "")} ↗
                </a>
              </div>
            </div>
          ))}
        </div>

        <div className="sec-label">
          <b>REF</b> — what clients say
        </div>
        <div className="grid2">
          <div className="cell">
            <p style={{ fontSize: "1rem", color: "var(--fog)" }}>
              “Five key hires over the last two years — we now only work with
              Transformer Talent.”
            </p>
            <p style={{ fontSize: "0.68rem", color: "var(--fog-30)", textTransform: "uppercase", letterSpacing: "0.14em" }}>
              CTO — Series B Fintech
            </p>
          </div>
          <div className="cell">
            <p style={{ fontSize: "1rem", color: "var(--fog)" }}>
              “Incredible high-intent candidates that are excellent fits with
              our business needs.”
            </p>
            <p style={{ fontSize: "0.68rem", color: "var(--fog-30)", textTransform: "uppercase", letterSpacing: "0.14em" }}>
              Founder — Series A, Sequoia-backed
            </p>
          </div>
        </div>

        <div className="sec-label">
          <b>NEXT</b> — your search
        </div>
        <div className="bigcta">
          <h2>
            Your role could be <span>LOG_05</span>.
          </h2>
          <p>
            Upload the JD and see potential matches now, or start with a
            30-minute brief.
          </p>
          <div className="cta-row" style={{ justifyContent: "center" }}>
            <Link className="btn hot" href="/talent">
              SEE MATCHES →
            </Link>
            <a
              className="btn cold"
              href="mailto:spencer@transformertalent.com?subject=New%20search"
            >
              Begin a search
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
