import type { Metadata } from "next";
import Link from "next/link";
import marketData from "@/data/market-index.json";
import { FAMILY_PAGES } from "@/lib/market";

export const metadata: Metadata = {
  title: "Market Index",
  description:
    "AI/ML and software engineering compensation bands in San Francisco and New York, computed from 123 live searches run by Transformer Talent.",
};

interface Band {
  family: string;
  city: string;
  roles: number;
  medianMin: number;
  medianMax: number;
  topOfMarket: number;
}

export default function MarketIndexPage() {
  const bands = (marketData as Band[]).filter((b) => b.city !== "Other / Remote");
  const remote = (marketData as Band[]).filter((b) => b.city === "Other / Remote");
  const totalRoles = (marketData as Band[]).reduce((s, b) => s + b.roles, 0);

  return (
    <main className="page">
      <div className="wrap">
        <h1 className="h-page b1">
          Market <span>index</span>
        </h1>
        <p className="page-intro b2">
          Base-salary bands computed from <b>{totalRoles} live searches</b> we
          have run for VC-backed startups — not scraped job posts, not survey
          self-reports. Figures are median band floor/ceiling per role family;
          “top of market” is the highest ceiling we&apos;ve carried.
        </p>

        <div className="sec-label">
          <b>IDX</b> — base salary, $k/year · SF &amp; NYC
        </div>
        <div style={{ overflowX: "auto" }} className="b3">
          <table className="data-table">
            <thead>
              <tr>
                <th>Role family</th>
                <th>Market</th>
                <th>Searches</th>
                <th>Median band</th>
                <th>Top of market</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={`${b.family}-${b.city}`}>
                  <td className="hi">{b.family}</td>
                  <td>{b.city}</td>
                  <td>{b.roles}</td>
                  <td className="hi">
                    ${b.medianMin}k – ${b.medianMax}k
                  </td>
                  <td className="hi">
                    <span className="sig">${b.topOfMarket}k</span>
                  </td>
                </tr>
              ))}
              {remote.map((b) => (
                <tr key={`${b.family}-remote`}>
                  <td className="hi">{b.family}</td>
                  <td>Remote / other</td>
                  <td>{b.roles}</td>
                  <td className="hi">
                    ${b.medianMin}k – ${b.medianMax}k
                  </td>
                  <td className="hi">
                    <span className="sig">${b.topOfMarket}k</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p
          className="page-intro"
          style={{ marginTop: "1.4rem", fontSize: "0.72rem", color: "var(--fog-30)" }}
        >
          Base salary only — equity excluded. Bands reflect what companies
          authorized us to offer, updated as searches run. Last computed
          2026-08.
        </p>

        <div className="sec-label">
          <b>READ</b> — what the data says
        </div>
        <div className="grid2 b4">
          <div className="cell">
            <h3>
              SF pays for <span>infra</span>.
            </h3>
            <p>
              Infrastructure/backend carries the strongest bands in San
              Francisco — median $192–252k with outliers to $600k. If
              you&apos;re hiring infra in SF on a $180k ceiling, the market
              will outbid you weekly.
            </p>
          </div>
          <div className="cell">
            <h3>
              FDE is the <span>arbitrage</span>.
            </h3>
            <p>
              Forward-deployed engineering bands start lower ($140–180k median
              in SF) but top out at $300–400k for senior operators — the
              widest spread of any family. Titles are unstandardized; great
              FDEs are priced by impact, not by band.
            </p>
          </div>
        </div>

        <div className="sec-label">
          <b>GUIDES</b> — per-role salary deep dives
        </div>
        <div className="logs" style={{ marginBottom: "1rem" }}>
          {FAMILY_PAGES.map((f) => (
            <Link
              key={f.slug}
              href={`/market-index/${f.slug}`}
              className="log"
              style={{ gridTemplateColumns: "1fr auto" }}
            >
              <span className="co">{f.title}</span>
              <span className="t" style={{ color: "var(--signal)" }}>READ →</span>
            </Link>
          ))}
        </div>

        <div className="sec-label">
          <b>NEXT</b> — price your role
        </div>
        <div className="bigcta">
          <h2>
            Wondering what <span>your role</span> should pay?
          </h2>
          <p>
            Upload the JD — the matches show you real candidates at real
            experience levels, and we&apos;ll tell you if the band is off — no call required.
          </p>
          <Link className="btn hot" href="/talent">
            SEE POTENTIAL MATCHES →
          </Link>
        </div>
      </div>
    </main>
  );
}
