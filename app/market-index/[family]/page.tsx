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
      <div className="wrap">
        <p className="sec-label" style={{ paddingTop: 0 }}>
          <Link href="/market-index" style={{ color: "var(--fog-30)", textDecoration: "none" }}>
            /market-index
          </Link>{" "}
          <b>— {page.family.toUpperCase()}</b>
        </p>
        <h1 className="h-page b1">{page.title}</h1>
        <p className="page-intro b2">{page.intro}</p>

        <div className="sec-label">
          <b>IDX</b> — base salary, $k/year · from {searches} live searches
        </div>
        <div style={{ overflowX: "auto" }} className="b3">
          <table className="data-table">
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
                  <td className="hi">{b.city}</td>
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

        <div className="sec-label">
          <b>READ</b> — what the data says
        </div>
        <div className="grid2 b4">
          <div className="cell" style={{ gridColumn: "1 / -1" }}>
            <p style={{ fontSize: "0.95rem", color: "var(--fog)" }}>{page.read}</p>
            <p style={{ fontSize: "0.72rem", color: "var(--fog-30)", marginBottom: 0 }}>
              Base salary only, equity excluded. Bands reflect what companies
              authorized us to offer. Last computed 2026-08.
            </p>
          </div>
        </div>

        {roles.length > 0 && (
          <>
            <div className="sec-label">
              <b>OPEN</b> — live {page.family.toLowerCase()} roles
            </div>
            <div className="logs">
              {roles.slice(0, 8).map((r) => (
                <Link
                  key={r.jobId}
                  href={`/roles/${roleSlug(r)}`}
                  className="log"
                  style={{ gridTemplateColumns: "70px 2fr 2fr 1fr" }}
                >
                  <span className="t">#{r.jobId}</span>
                  <span className="co">{r.title}</span>
                  <span className="role" style={{ fontSize: "0.72rem" }}>
                    {r.locations.join(" · ") || "USA"}
                  </span>
                  <span className="t" style={{ color: "var(--signal)", textAlign: "right" }}>
                    {r.salary}
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}

        <div className="sec-label">
          <b>NEXT</b> — hiring for this profile?
        </div>
        <div className="bigcta">
          <h2>
            Upload your JD. <span>We&apos;ll share potential matches.</span>
          </h2>
          <p>
            Anonymized profiles of engineers we&apos;d put in front of you —
            and an honest read on whether your band clears the market.
          </p>
          <Link className="btn hot" href="/talent">
            SEE POTENTIAL MATCHES →
          </Link>
        </div>
      </div>
    </main>
  );
}
