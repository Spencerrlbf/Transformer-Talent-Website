import { NextResponse } from "next/server";

// Tracked links from earlier outreach emails. The link store is gone while the
// project is paused, so every old link lands on the home page.
export function GET(req: Request) {
  return NextResponse.redirect(new URL("/", req.url), 302);
}
