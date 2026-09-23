// Company snapshots for the report card's hovers: the public facts from each
// company's LinkedIn page, out of the global company_context cache. A page
// not on file yet is fetched once ever ($0.004, shared by every tenant); the
// cap of MAX_COMPANY_SLUGS per call is the spend cap.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { getCompanyContexts, snapshotOf } from "@/lib/server/sourcing/company-context";
import { MAX_COMPANY_SLUGS, type CompanySnapshot } from "@/lib/company-snapshot";

export const maxDuration = 30;

/** GET ?slugs=a,b,c (lower case, at most MAX_COMPANY_SLUGS, distinct) ->
 *  { companies: { [slug]: CompanySnapshot | null } }, null for a page that
 *  could not be fetched. */
export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });

  const slugs = [
    ...new Set(
      (req.nextUrl.searchParams.get("slugs") || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[a-z0-9._-]+$/.test(s))
    ),
  ];
  if (!slugs.length || slugs.length > MAX_COMPANY_SLUGS) {
    return NextResponse.json({ error: "bad_slugs" }, { status: 400 });
  }

  const companies: Record<string, CompanySnapshot | null> = {};
  for (const slug of slugs) companies[slug] = null;
  try {
    // A recruiter's hover must never show invented facts: where runs are
    // mocked (preview deploys) the real page is fetched when a key exists,
    // and without one only what the cache holds is served.
    const contexts = await getCompanyContexts(slugs, { liveIfKey: true });
    for (const slug of slugs) companies[slug] = snapshotOf(contexts.get(slug));
  } catch (err) {
    console.error("company snapshot lookup failed:", err);
  }
  return NextResponse.json({ companies });
}
