import { NextRequest, NextResponse } from "next/server";
import { looksLikeBot, recordOpen, TOKEN_RE } from "@/lib/server/tracked-links";

// Tracked outreach link: log a human-looking open, then redirect to the page
// the link was minted for. Unknown or malformed tokens land on the homepage —
// no 404s that would reveal which tokens exist.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!TOKEN_RE.test(token)) return NextResponse.redirect(new URL("/", req.url));

  const countIt = !looksLikeBot(
    req.headers.get("user-agent"),
    req.headers.get("purpose") || req.headers.get("sec-purpose")
  );
  const target = await recordOpen(token, countIt);
  return NextResponse.redirect(new URL(target || "/", req.url));
}

// HEAD probes (scanners) resolve without counting or revealing the target.
export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: { "cache-control": "no-store" } });
}
