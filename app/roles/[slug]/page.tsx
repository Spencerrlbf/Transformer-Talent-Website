import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRoles, getRoleBySlug, roleSlug, parseSalary } from "@/lib/roles";

export const revalidate = 3600;

export async function generateStaticParams() {
  const roles = await getRoles();
  return roles.map((role) => ({ slug: roleSlug(role) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const role = await getRoleBySlug(slug);
  if (!role) return {};
  const where =
    role.locations.length > 2
      ? `${role.locations.slice(0, 2).join(", ")} + remote`
      : role.locations.join(", ") || "USA";
  return {
    title: `${role.title} — ${where}${role.salary ? ` · ${role.salary}` : ""}`,
    description: `${role.title} at a ${role.company?.stage || "VC-backed"} startup (${where}${
      role.workplace ? `, ${role.workplace.toLowerCase()}` : ""
    }). ${role.company?.blurb || role.description || ""} Apply via Transformer Talent.`.slice(0, 300),
  };
}

const POSTED = "2026-08-14";

export default async function RolePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const role = await getRoleBySlug(slug);
  if (!role) notFound();

  const band = parseSalary(role.salary);
  const ld = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: role.title,
    description: [role.description, role.company?.blurb].filter(Boolean).join(" "),
    datePosted: POSTED,
    employmentType: "FULL_TIME",
    hiringOrganization: {
      "@type": "Organization",
      name: "Confidential — via Transformer Talent",
      sameAs: "https://transformertalent.com",
    },
    jobLocation: (role.locations.length ? role.locations : ["USA"]).map((loc) => ({
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: loc, addressCountry: "US" },
    })),
    ...(band
      ? {
          baseSalary: {
            "@type": "MonetaryAmount",
            currency: "USD",
            value: {
              "@type": "QuantitativeValue",
              minValue: band.min,
              maxValue: band.max,
              unitText: "YEAR",
            },
          },
        }
      : {}),
  };

  const facts: [string, string][] = (
    [
      ["COMP", role.salary],
      ["EQUITY", role.equity],
      ["LOCATION", role.locations.join(" · ")],
      ["WORKPLACE", role.workplace],
      ["EXPERIENCE", role.yoe],
      ["VISA", role.visa],
      ["STACK", role.techStack],
      ["INDUSTRY", role.industry],
    ] as [string, string][]
  ).filter(([, v]) => v && v !== "-");

  const c = role.company;

  return (
    <main className="page">
      <div className="wrap">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
        />
        <p className="sec-label" style={{ paddingTop: 0 }}>
          <Link href="/roles" style={{ color: "var(--fog-30)", textDecoration: "none" }}>
            /roles
          </Link>{" "}
          <b>— ROLE_{role.jobId}</b>
        </p>
        <h1 className="h-page b1">{role.title}</h1>
        <p className="page-intro b2">{role.description}</p>

        <div className="grid2 b3">
          <div className="cell">
            <h3>
              The <span>role</span>
            </h3>
            <dl className="kv">
              {facts.map(([k, v]) => (
                <FactRow key={k} k={k} v={v} />
              ))}
            </dl>
          </div>
          <div className="cell">
            <h3>
              The <span>company</span>
            </h3>
            {c ? (
              <>
                <p>{c.blurb}</p>
                <dl className="kv">
                  {c.stage && <FactRow k="STAGE" v={c.stage} />}
                  {c.funding && <FactRow k="FUNDING" v={c.funding} />}
                  {c.teamSize && <FactRow k="TEAM" v={c.teamSize} />}
                  {c.founded && <FactRow k="FOUNDED" v={c.founded} />}
                  {c.investors && <FactRow k="BACKING" v={c.investors} />}
                </dl>
              </>
            ) : (
              <p>A VC-backed startup — full details during the process.</p>
            )}
          </div>
        </div>

        <div className="cta-row" style={{ marginTop: "2.4rem" }}>
          <Link
            className="btn hot"
            href={`/apply?role=${encodeURIComponent(`${role.title} (#${role.jobId})`)}`}
          >
            APPLY FOR THIS ROLE →
          </Link>
          <Link className="btn cold" href="/roles">
            All open roles
          </Link>
        </div>
      </div>
    </main>
  );
}

function FactRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
