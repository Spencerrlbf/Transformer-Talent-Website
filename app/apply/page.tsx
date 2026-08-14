import type { Metadata } from "next";
import ApplyForm from "@/components/ApplyForm";

export const metadata: Metadata = {
  title: "Apply",
  description:
    "Send us your profile once and get matched against every AI/ML and software engineering role we're working on — including ones that never get posted.",
};

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string }>;
}) {
  const { role } = await searchParams;

  return (
    <main className="page-main">
      <h1 className="page-title">Apply</h1>
      <p className="page-intro">
        One profile, every role. Tell us who you are and we&apos;ll match you
        against everything we&apos;re working on — most of our placements come
        from roles that are never posted publicly.
      </p>
      <ApplyForm defaultRole={role} />
    </main>
  );
}
