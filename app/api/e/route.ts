import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sbRest } from "@/lib/server/supabase";

// Recruiter-page analytics beacon. sendBeacon posts a one-line event; we
// store it with a daily one-way visitor hash (no cookies, not reversible).
// The unique index dedupes repeats per visitor per day, so replays and
// refresh spam collapse into one row. Always 204 — analytics never errors
// at a candidate.

const EVENTS = new Set([
  "view",
  "role_open",
  "booking_click",
  "email_copy",
  "linkedin_click",
  "referral_open",
  "future_open",
]);

export async function POST(req: NextRequest) {
  let body: { p?: unknown; e?: unknown; r?: unknown; ref?: unknown };
  try {
    body = JSON.parse(await req.text());
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const profileId = String(body.p ?? "");
  const event = String(body.e ?? "");
  const roleId = String(body.r ?? "").slice(0, 40);
  if (!/^[0-9a-f-]{36}$/.test(profileId) || !EVENTS.has(event)) {
    return new NextResponse(null, { status: 204 });
  }

  let referrer: string | null = null;
  try {
    referrer = body.ref ? new URL(String(body.ref)).hostname.slice(0, 120) : null;
  } catch {
    referrer = null;
  }

  const ip =
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";
  const day = new Date().toISOString().slice(0, 10);
  const visitorHash = createHash("sha256")
    .update([ip, req.headers.get("user-agent") || "", day, process.env.SUPABASE_SERVICE_ROLE_KEY || ""].join("|"))
    .digest("hex")
    .slice(0, 32);

  await sbRest("page_events?on_conflict=recruiter_profile_id,event,role_id,visitor_hash,day", {
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: JSON.stringify({
      recruiter_profile_id: profileId,
      event,
      role_id: roleId,
      referrer,
      visitor_hash: visitorHash,
      day,
    }),
  }).catch(() => {});

  return new NextResponse(null, { status: 204 });
}
