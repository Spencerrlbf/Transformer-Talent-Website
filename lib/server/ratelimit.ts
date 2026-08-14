import { sbInsert, sbRest } from "./supabase";

// Sliding-window limits backed by the rate_limit_events table. Fail-closed:
// if the check itself errors we deny, since this guards paid OpenAI calls.
export async function allow(
  bucket: string,
  limit: number,
  windowHours: number
): Promise<boolean> {
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();
  const res = await sbRest(
    `rate_limit_events?bucket=eq.${encodeURIComponent(bucket)}&created_at=gte.${since}&select=id`,
    { prefer: "count=exact", headers: { Range: "0-0" } }
  );
  if (!res.ok) return false;
  const range = res.headers.get("content-range") || "0-0/0";
  const count = parseInt(range.split("/")[1] || "0", 10);
  if (count >= limit) return false;
  await sbInsert("rate_limit_events", { bucket });
  return true;
}
