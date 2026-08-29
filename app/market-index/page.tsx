import type { Metadata } from "next";
import Link from "next/link";
import marketData from "@/data/market-index.json";
import { FAMILY_PAGES, bandsFor } from "@/lib/market";
import SalaryChart from "@/components/SalaryChart";

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

const dotClass = (city: string) =>
  city === "San Francisco" ? "sf" : city === "New York" ? "nyc" : "remote";

export default function MarketIndexPage() {
  const all = marketData as Band[];
  const families = [...new Set(all.map((b) => b.family))];
  const totalRoles = all.reduce((s, b) => s + b.roles, 0);

  // Derived headline stats (§9.7, approved) — same JSON, no new claims.
  const strongest = all.reduce((a, b) => (b.medianMax > a.medianMax ? b : a));
  const top = all.reduce((a, b) => (b.topOfMarket > a.topOfMarket ? b : a));

  // Grouped in threes by family: SF, NYC, then Remote/other per family.
  const cityOrder = ["San Francisco", "New York", "Other / Remote"];
  const grouped = families.map((fam) => ({
    family: fam,
    rows: all
      .filter((b) => b.family === fam)
      .sort((a, b) => cityOrder.indexOf(a.city) - cityOrder.indexOf(b.city)),
  }));

  return (
    <main className="page">
      <div className="wrap mi">
        <h1 className="h-page b1">
          Market <span>index</span>
        </h1>
        <p className="page-intro b2">
          Base-salary bands computed from <b>{totalRoles} live searches</b> we
          have run for VC-backed startups — not scraped job posts, not survey
          self-reports. Figures are median band floor/ceiling per role family;
          “top of market” is the highest ceiling we&apos;ve carried.
        </p>

        <div className="mi-stats">
          <div className="mi-stat">
            <div className="lbl">Live searches</div>
            <div className="val">{totalRoles}</div>
            <div className="sub">every band computed from real mandates</div>
          </div>
          <div className="mi-stat">
            <div className="lbl">Role families</div>
            <div className="val">{families.length}</div>
            <div className="sub">SF · NYC · remote, tracked separately</div>
          </div>
          <div className="mi-stat">
            <div className="lbl">Strongest band</div>
            <div className="val">${strongest.medianMax}k</div>
            <div className="sub">
              {strongest.family} · {strongest.city === "Other / Remote" ? "Remote" : strongest.city}
            </div>
          </div>
          <div className="mi-stat">
            <div className="lbl">Top of market</div>
            <div className="val">${top.topOfMarket}k</div>
            <div className="sub">
              {top.family} · {top.city === "Other / Remote" ? "Remote" : top.city}
            </div>
          </div>
        </div>

        <section className="mi-sec">
          <h2>Median bands at a glance</h2>
          <div className="mi-chartwrap b3">
            <SalaryChart />
          </div>
        </section>

        <section className="mi-sec">
          <h2>The index</h2>
          <div className="mi-scroll b3">
            <table className="data-table mi-table">
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
                {grouped.map((g) =>
                  g.rows.map((b, i) => (
                    <tr key={`${b.family}-${b.city}`} className={i === 0 ? "mi-group" : ""}>
                      <td className="hi">{i === 0 ? b.family : ""}</td>
                      <td>
                        <span className={`mi-dot ${dotClass(b.city)}`} />{" "}
                        {b.city === "Other / Remote" ? "Remote / other" : b.city}
                      </td>
                      <td>{b.roles}</td>
                      <td className="hi">
                        ${b.medianMin}k – ${b.medianMax}k
                      </td>
                      <td className="mi-top">${b.topOfMarket}k</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="mi-note">
            Base salary only — equity excluded. Bands reflect what companies
            authorized us to offer, updated as searches run. Last computed
            2026-08.
          </p>
        </section>

        <section className="mi-sec">
          <h2>What the data says</h2>
          <div className="grid2 b4">
            <div className="cell">
              <h3>SF pays for infra.</h3>
              <p>
                Infrastructure/backend carries the strongest bands in San
                Francisco — median $192–252k with outliers to $600k. If
                you&apos;re hiring infra in SF on a $180k ceiling, the market
                will outbid you weekly.
              </p>
            </div>
            <div className="cell">
              <h3>FDE is the arbitrage.</h3>
              <p>
                Forward-deployed engineering bands start lower ($140–180k median
                in SF) but top out at $300–400k for senior operators — the
                widest spread of any family. Titles are unstandardized; great
                FDEs are priced by impact, not by band.
              </p>
            </div>
          </div>
        </section>

        <section className="mi-sec">
          <h2>Per-role salary guides</h2>
          <div className="logs">
            {FAMILY_PAGES.map((f) => {
              const searches = bandsFor(f.family).reduce((s, b) => s + b.roles, 0);
              return (
                <Link key={f.slug} href={`/market-index/${f.slug}`} className="log mi-guide">
                  <span className="co">{f.title}</span>
                  <span className="mi-count">{searches} searches</span>
                  <span className="mi-read">READ →</span>
                </Link>
              );
            })}
          </div>
        </section>

        <div className="mi-cta">
          <div>
            <h2>
              Wondering what <span>your role</span> should pay?
            </h2>
            <p>
              Upload the JD — the matches show you real candidates at real
              experience levels, and we&apos;ll tell you if the band is off — no call required.
            </p>
          </div>
          <Link className="board-btn" href="/talent">
            SEE POTENTIAL MATCHES →
          </Link>
        </div>
      </div>
    </main>
  );
}
