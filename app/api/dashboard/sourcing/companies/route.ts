// Ideal-companies typeahead: name → LinkedIn companies via the provider.
import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { searchCompanies } from "@/lib/server/sourcing/harvest";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ companies: [] });
  try {
    const companies = await searchCompanies(q, 8);
    return NextResponse.json({ companies });
  } catch (err) {
    console.error("company search failed:", err);
    return NextResponse.json({ companies: [] });
  }
}
