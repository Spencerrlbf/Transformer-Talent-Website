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
        {/* No hero here — visitors arrive to finish an application; the
            table + rail start immediately. */}
        <div className={`b1${speculative === "1" ? "" : " apply-layout"}`} style={{ paddingTop: "1.6rem" }}>
          {speculative !== "1" && (
            <div style={{ minWidth: 0 }}>
              <h1 className="apply-h">Add roles to your application</h1>
              <RolesTable roles={roles} showSelectionUI={false} variant="apply" />
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
