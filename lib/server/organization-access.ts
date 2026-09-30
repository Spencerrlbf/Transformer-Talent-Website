// Resolve organization-owned references before exposing a dependent resource.
import { sbRest } from "./supabase";

export async function jobInOrg(orgId: string, jobId: string): Promise<boolean> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=id&limit=1`
  );
  if (!res.ok) throw Error("job_ownership_read_failed");
  return ((await res.json()) as { id: string }[]).length > 0;
}
