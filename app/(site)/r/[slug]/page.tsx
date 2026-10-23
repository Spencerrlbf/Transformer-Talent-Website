import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadRecruiterPage } from "@/lib/server/recruiter-page";
import BoardClient from "@/components/board/BoardClient";

export const revalidate = 300; // profile + roles change via dashboard; 5 min is fresh

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadRecruiterPage(slug);
  if (!page) return { title: "Recruiter" };
  return {
    title: `${page.profile.name} · ${page.org.name}`,
    description:
      page.profile.bio ||
      `Roles ${page.profile.name} is recruiting at ${page.org.name}. Apply directly.`,
  };
}

export default async function RecruiterPublicPage({ params }: Params) {
  const { slug } = await params;
  const page = await loadRecruiterPage(slug);
  if (!page) notFound();
  return (
    <BoardClient
      org={{ slug: page.org.slug, name: page.org.name }}
      recruiter={{
        id: page.profile.id,
        name: page.profile.name,
        photoUrl: page.profile.photoUrl,
        linkedinUrl: page.profile.linkedinUrl,
        website: page.org.website,
        bio: page.profile.bio,
        bookingUrl: page.profile.bookingUrl,
        contactEmail: page.profile.contactEmail,
        referralAmount: page.referralAmount,
      }}
      roles={page.roles.map((r) => ({
        jobId: r.jobId,
        title: r.title,
        salary: r.salary,
        locations: r.locations,
        workplace: r.workplace,
        yoe: r.yoe,
        roleType: r.roleType,
        techStack: r.techStack,
        visa: r.visa,
        about: r.jd?.about || "",
        doing: r.jd?.doing || [],
        needs: r.jd?.needs || [],
        bonus: r.jd?.bonus || [],
      }))}
    />
  );
}
