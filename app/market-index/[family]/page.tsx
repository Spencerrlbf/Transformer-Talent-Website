import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FAMILY_PAGES, bandsFor } from "@/lib/market";
import { getRoles, roleSlug } from "@/lib/roles";

export function generateStaticParams() {
  return FAMILY_PAGES.map((f) => ({ family: f.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ family: string }>;
}): Promise<Metadata> {
  const { family } = await params;
  const page = FAMILY_PAGES.find((f) => f.slug === family);
  if (!page) return {};
  const bands = bandsFor(page.family);
  const searches = bands.reduce((s, b) => s + b.roles, 0);
  return {
    title: `${page.title} 2026 — Real Data from ${searches} Searches`,
    description: `${page.intro.slice(0, 250)}`,
  };
}

const dotClass = (city: string) =>
  city === "San Francisco" ? "sf" : city === "New York" ? "nyc" : "remote";

export default async function FamilySalaryPage({
  params,
}: {
  params: Promise<{ family: string }>;
}) {
  const { family } = await params;
  const page = FAMILY_PAGES.find((f) => f.slug === family);
  if (!page) notFound();

  const bands = bandsFor(page.family);
  const searches = bands.reduce((s, b) => s + b.roles, 0);
  const roles = (await getRoles()).filter(
    (r) =>
      r.roleType &&
      page.family
        .toLowerCase()
        .split(" / ")
        .some((k) => r.roleType.toLowerCase().includes(k.split(" ")[0].toLowerCase()))
  );

  return (
    <main className="page">
      <div className="wrap mi">
        <p className="rd-crumb">
          <Link href="/market-index">/market-index</Link>{" "}
          <b>— {page.family.toUpperCase()}</b>
        </p>
        <h1 className="h-page b1">{page.title}</h1>
        <p className="page-intro b2">{page.intro}</p>

        <section className="mi-sec">
          <h2>Base salary, $k/year · from {searches} live searches</h2>
          <div className="mi-scroll b3">
            <table className="data-table mi-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Searches</th>
                  <th>Median band</th>
                  <th>Top of market</th>
                </tr>
              </thead>
              <tbody>
                {bands.map((b) => (
                  <tr key={b.city}>
                    <td className="hi">
                      <span className={`mi-dot ${dotClass(b.city)}`} />{" "}
                      {b.city === "Other / Remote" ? "Remote / other" : b.city}
                    </td>
                    <td>{b.roles}</td>
                    <td className="hi">
                      ${b.medianMin}k – ${b.medianMax}k
                    </td>
                    <td className="mi-top">${b.topOfMarket}k</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mi-sec">
          <h2>What the data says</h2>
          <div className="mi-readpanel b4">
            <p>{page.read}</p>
            <p className="mi-note" style={{ marginBottom: 0 }}>
              Base salary only, equity excluded. Bands reflect what companies
              authorized us to offer. Last computed 2026-08.
            </p>
          </div>
        </section>

        {roles.length > 0 && (
          <section className="mi-sec">
            <h2>Live {page.family.toLowerCase()} roles</h2>
            <div className="logs">
              {roles.slice(0, 8).map((r) => (
                <Link key={r.jobId} href={`/roles/${roleSlug(r)}`} className="log mi-role">
                  <span className="mi-id">#{r.jobId}</span>
                  <span className="co">{r.title}</span>
                  <span className="role">{r.locations.join(" · ") || "USA"}</span>
                  <span className="mi-top" style={{ textAlign: "right" }}>{r.salary}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="mi-cta">
          <div>
            <h2>
              Upload your JD. <span>We&apos;ll share potential matches.</span>
            </h2>
            <p>
              Anonymized profiles of engineers we&apos;d put in front of you —
              and an honest read on whether your band clears the market.
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
