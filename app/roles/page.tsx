import type { Metadata } from "next";
import Link from "next/link";
import { getRoles, parseSalary } from "@/lib/roles";
import RolesTable from "@/components/RolesTable";

export const metadata: Metadata = {
  title: "Open Roles",
  description:
    "All open AI/ML and software engineering roles we are hiring for at VC-backed startups across the US.",
};

export const revalidate = 3600;

const POSTED = "2026-08-14";

export default async function RolesPage() {
  const roles = await getRoles();

  const jobPostingLd = roles.slice(0, 100).map((role) => {
    const band = parseSalary(role.salary);
    return {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: role.title,
      description: role.description || role.title,
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
  });

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
          <b>{roles.length} live roles</b> with VC-backed startups we work with
          directly. Apply once — we&apos;ll consider you for everything
          we&apos;re working on, including roles that never get posted.
        </p>
        <div className="b3">
          <RolesTable roles={roles} />
        </div>
        <p className="page-intro" style={{ marginTop: "2.4rem" }}>
          No fit above?{" "}
          <Link href="/apply" style={{ color: "var(--signal)" }}>
            Send us your profile anyway
          </Link>{" "}
          — many of our placements come from roles that never get posted.
        </p>
      </div>
    </main>
  );
}
