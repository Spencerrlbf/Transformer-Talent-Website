import { redirect } from "next/navigation";

// Sourcing moved into the job workspace's Sourcing tab; keep the old URL alive.
export default async function SourcingRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/dashboard/jobs/${encodeURIComponent(id)}?tab=sourcing`);
}
