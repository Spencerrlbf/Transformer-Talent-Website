// The automatic review of a new applicant (resume reading, LinkedIn lookup,
// AI scoring) costs money per person, so each company gets its own daily
// allowance: organizations.daily_review_limit, 300 unless raised for that
// company. One company's volume never touches another's. Nobody is turned
// away: over the allowance an application is kept as "queued" and the nightly
// queue (review-queue.ts) reviews it once the allowance has room.
import { allow } from "./ratelimit";
import { sbRest } from "./supabase";

export const DEFAULT_DAILY_REVIEWS = 300;

async function dailyLimit(orgId: string): Promise<number> {
  const res = await sbRest(`organizations?id=eq.${orgId}&select=daily_review_limit`);
  const [row] = res.ok ? ((await res.json()) as { daily_review_limit: number | null }[]) : [];
  const n = Number(row?.daily_review_limit);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_REVIEWS;
}

/** Takes one review from the company's allowance for the last 24 hours.
 *  False when it is used up, or when the check itself failed (fail-closed:
 *  the application then waits in the queue rather than spending blind). */
export async function takeReview(orgId: string): Promise<boolean> {
  return allow(`review:${orgId}`, await dailyLimit(orgId), 24);
}
