// The automatic review of a new applicant (resume reading, LinkedIn lookup,
// AI scoring) costs money per person, so each company gets its own daily
// allowance: organizations.daily_review_limit, 300 unless raised for that
// company. One company's volume never touches another's. Nobody is turned
// away: over the allowance an application is kept as "queued" and the nightly
// queue (review-queue.ts) reviews it once the allowance has room.
import { allow } from "./ratelimit";
import { sbRest } from "./supabase";

export const DEFAULT_DAILY_REVIEWS = 300;

// The allowance is a sliding 24 hours, not a calendar day. takeReview and
// reviewRoom share this so the two can never disagree about the window.
const WINDOW_HOURS = 24;

/** The company's daily limit, or null when the lookup itself failed. */
async function dailyLimit(orgId: string): Promise<number | null> {
  const res = await sbRest(`organizations?id=eq.${orgId}&select=daily_review_limit`);
  if (!res.ok) return null;
  const [row] = (await res.json()) as { daily_review_limit: number | null }[];
  const n = Number(row?.daily_review_limit);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_REVIEWS;
}

/** Takes one review from the company's allowance for the last 24 hours.
 *  False when it is used up, or when the check itself failed (fail-closed:
 *  the application then waits in the queue rather than spending blind). */
export async function takeReview(orgId: string): Promise<boolean> {
  return allow(`review:${orgId}`, (await dailyLimit(orgId)) ?? DEFAULT_DAILY_REVIEWS, WINDOW_HOURS);
}

/** How many reviews the company has left right now, without taking any: its
 *  limit minus the review events in the same window allow() counts. The
 *  nightly queue uses it to decide how many of a company's applications to
 *  pick up; takeReview stays the check that actually spends. Fail-closed:
 *  any error reads as no room. */
export async function reviewRoom(orgId: string): Promise<number> {
  try {
    const limit = await dailyLimit(orgId);
    if (limit === null) return 0;
    // Counted exactly as allow() counts (lib/server/ratelimit.ts).
    const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
    const res = await sbRest(
      `rate_limit_events?bucket=eq.${encodeURIComponent(`review:${orgId}`)}&created_at=gte.${since}&select=id`,
      { prefer: "count=exact", headers: { Range: "0-0" } }
    );
    if (!res.ok) return 0;
    const range = res.headers.get("content-range") || "0-0/0";
    const used = parseInt(range.split("/")[1] || "0", 10);
    if (!Number.isFinite(used)) return 0;
    return Math.max(0, limit - used);
  } catch {
    return 0;
  }
}
