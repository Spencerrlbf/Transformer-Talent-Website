import type { Metadata } from "next";
import ApplyForm from "@/components/ApplyForm";
import RolesTable from "@/components/RolesTable";
import { getRoles } from "@/lib/roles";

export const metadata: Metadata = {
  title: "Apply",
  description:
    "Apply once to one or many roles — we match your profile against everything we're working on, including roles that never get posted.",
};

export const revalidate = 3600;

function slugOf(title: string, jobId: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base}-${jobId}`;
}

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; speculative?: string }>;
}) {
  const { role, speculative } = await searchParams;
  const roles = await getRoles();

  return (
    <main className="page">
      <div className="wrap">
        <h1 className="h-page b1">
          <span>Apply</span> once
        </h1>
        <p className="page-intro b2">
          Pick one role or several — either way we match your profile against{" "}
          <b>everything</b> we&apos;re working on and show you other fits
          instantly. Most of our placements come from roles that are never
          posted publicly.
        </p>
        <div className={`b3${speculative === "1" ? "" : " breakout apply-layout"}`}>
          {speculative !== "1" && (
            <div style={{ minWidth: 0 }}>
              <RolesTable roles={roles} showSelectionUI={false} />
            </div>
          )}
          <aside className={speculative === "1" ? "apply-rail-solo" : "apply-rail"}>
            <ApplyForm
              roles={roles.map((r) => ({
                jobId: r.jobId,
                title: r.title,
                salary: r.salary,
                locations: r.locations,
                workplace: r.workplace,
                yoe: r.yoe,
                slug: slugOf(r.title, r.jobId),
              }))}
              preselected={role}
              speculative={speculative === "1"}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}
