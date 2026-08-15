import { NextRequest, NextResponse } from "next/server";
import { allow } from "@/lib/server/ratelimit";
import { sbRest } from "@/lib/server/supabase";
import { getRoles } from "@/lib/roles";

// Adds one suggested role to a just-submitted application. Guarded hard:
// the application must be under an hour old, the role must be one WE
// suggested (matched_role_ids), and totals stay capped — so the uuid the
// applicant holds can't be used to spray applications.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOTAL_ROLES = 7; // 3 applied + up to 4 suggested

export async function POST(req: NextRequest) {
  let body: { applicationId?: string; jobId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const applicationId = String(body.applicationId || "");
  const jobId = String(body.jobId || "").slice(0, 20);
  if (!UUID.test(applicationId) || !jobId) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const ip =
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    "unknown";
  if (!(await allow(`addrole:ip:${ip}`, 20, 24))) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const res = await sbRest(
    `website_applications?id=eq.${applicationId}&select=id,created_at,role_ids,role_titles,matched_role_ids`
  );
  if (!res.ok) return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  const [app] = await res.json();
  if (!app) return NextResponse.json({ error: "Application not found." }, { status: 404 });

  if (Date.now() - new Date(app.created_at).getTime() > 3600_000) {
    return NextResponse.json(
      { error: "This application can no longer be changed — apply again or email us." },
      { status: 403 }
    );
  }
  const matched: string[] = app.matched_role_ids || [];
  if (!matched.includes(jobId)) {
    return NextResponse.json({ error: "That role wasn't suggested for this application." }, { status: 403 });
  }
  const roleIds: string[] = app.role_ids || [];
  if (roleIds.includes(jobId)) return NextResponse.json({ ok: true }); // idempotent
  if (roleIds.length >= MAX_TOTAL_ROLES) {
    return NextResponse.json({ error: "Role limit reached for this application." }, { status: 403 });
  }

  const roles = await getRoles();
  const role = roles.find((r) => r.jobId === jobId);
  if (!role) return NextResponse.json({ error: "Role not found." }, { status: 404 });

  const patch = await sbRest(`website_applications?id=eq.${applicationId}`, {
    method: "PATCH",
    body: JSON.stringify({
      role_ids: [...roleIds, jobId],
      role_titles: [...(app.role_titles || []), `${role.title} (#${jobId})`],
    }),
    prefer: "return=minimal",
  });
  if (!patch.ok) return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
