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
    <main className="page">
      <div className="wrap">
        <h1 className="h-page b1">
          <span>Apply</span> once
        </h1>
        <p className="page-intro b2">
          One profile, every role. Tell us who you are and we match you against
          everything we&apos;re working on — most of our placements come from
          roles that are <b>never posted publicly</b>.
        </p>
        <div className="b3">
          <ApplyForm defaultRole={role} />
        </div>
      </div>
    </main>
  );
}
