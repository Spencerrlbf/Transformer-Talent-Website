import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadOrgBySlug, loadOrgRoles } from "@/lib/server/org-board";
import BoardClient from "@/components/board/BoardClient";

export const revalidate = 300; // roles change via dashboard; 5 min is fresh enough

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const org = await loadOrgBySlug(slug);
  return {
    title: org ? `${org.name} — Open Roles` : "Job Board",
    description: org
      ? `Open engineering roles at ${org.name}. Every application is screened by Transformer Talent.`
      : undefined,
  };
}

export default async function BoardPage({ params }: Params) {
  const { slug } = await params;
  const org = await loadOrgBySlug(slug);
  if (!org || org.slug === "transformer-talent") notFound();
  const roles = await loadOrgRoles(org.id);
  return (
    <BoardClient
      org={{ slug: org.slug, name: org.name }}
      roles={roles.map((r) => ({
        jobId: r.jobId,
        title: r.title,
        salary: r.salary,
        locations: r.locations,
        workplace: r.workplace,
        yoe: r.yoe,
        roleType: r.roleType,
        about: r.jd?.about || "",
        doing: r.jd?.doing || [],
        needs: r.jd?.needs || [],
        bonus: r.jd?.bonus || [],
      }))}
    />
  );
}
