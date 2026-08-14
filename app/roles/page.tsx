import type { Metadata } from "next";
import Link from "next/link";
import { getRoles } from "@/lib/roles";

export const metadata: Metadata = {
  title: "Open Roles",
  description:
    "Open AI/ML and software engineering roles at VC-backed startups — backend, full-stack, frontend, and forward-deployed engineering positions in SF and NYC.",
};

const POSTED = "2026-08-14";

export default async function RolesPage() {
  const roles = await getRoles();

  const jobPostingLd = roles.map((role) => ({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: role.title,
    description: role.description,
    datePosted: POSTED,
    employmentType: "FULL_TIME",
    hiringOrganization: {
      "@type": "Organization",
      name: "Confidential — via Transformer Talent",
      sameAs: "https://transformertalent.com",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: role.location,
        addressCountry: "US",
      },
    },
    baseSalary: {
      "@type": "MonetaryAmount",
      currency: "USD",
      value: {
        "@type": "QuantitativeValue",
        minValue: role.salaryMin,
        maxValue: role.salaryMax,
        unitText: "YEAR",
      },
    },
  }));

  return (
    <main className="page">
      <div className="wrap">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jobPostingLd) }}
        />
        <h1 className="h-page b1">
          Open <span>roles</span>
        </h1>
        <p className="page-intro b2">
          Every role is with a VC-backed startup we work with directly. Apply
          once — we match you against <b>everything</b> we&apos;re working on,
          including roles that never get posted.
        </p>
        <div className="match-grid b3">
          {roles.map((role, i) => (
            <Link
              key={role.slug}
              href={`/apply?role=${encodeURIComponent(role.title)}`}
              className="match-card"
              style={{ textDecoration: "none" }}
            >
              <div className="ref-row">
                <span className="ref">ROLE_{String(i + 1).padStart(2, "0")}</span>
                <span className="score">OPEN</span>
              </div>
              <h4>{role.title}</h4>
              <div className="meta">
                {role.location} · <span style={{ color: "var(--signal)" }}>{role.salary}</span>
              </div>
              <p className="prev">{role.description}</p>
              <div className="tags">
                {role.tags.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
        <p className="page-intro" style={{ marginTop: "2.6rem" }}>
          No fit above?{" "}
          <Link href="/apply" style={{ color: "var(--signal)" }}>
            Send your profile anyway
          </Link>{" "}
          — most of our placements come from roles that never get posted.
        </p>
      </div>
    </main>
  );
}
