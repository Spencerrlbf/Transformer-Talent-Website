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
    <main className="page-main">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jobPostingLd) }}
      />
      <h1 className="page-title">Open Roles</h1>
      <p className="page-intro">
        Every role below is with a VC-backed startup we work with directly.
        Apply once — we&apos;ll match you against everything we&apos;re
        working on, including roles we can&apos;t list publicly.
      </p>
      <div className="roles-grid">
        {roles.map((role) => (
          <Link
            key={role.slug}
            href={`/apply?role=${encodeURIComponent(role.title)}`}
            className="role-card"
          >
            <div className="role-title">{role.title}</div>
            <div className="role-meta">
              <span>{role.location}</span>
              <span className="role-salary">{role.salary}</span>
            </div>
            <div className="role-tags">
              {role.tags.map((tag) => (
                <span key={tag} className="role-tag">
                  {tag}
                </span>
              ))}
            </div>
          </Link>
        ))}
      </div>
      <p className="page-intro" style={{ marginTop: "3rem" }}>
        Don&apos;t see your fit?{" "}
        <Link href="/apply" style={{ color: "var(--amber)" }}>
          Send us your profile anyway
        </Link>{" "}
        — most of our placements come from roles that never get posted.
      </p>
    </main>
  );
}
