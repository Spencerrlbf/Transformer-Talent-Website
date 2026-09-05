import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { emailConfigured } from "@/lib/server/nylas";
import {
  accountFor,
  candidateContact,
  composeJobs,
  listTemplates,
  trackedLinkUrl,
} from "@/lib/server/email-compose";
import { loadProfile } from "@/lib/server/recruiter-profile";
import { ensureDefaultTemplates } from "@/lib/server/quick-actions";
import { sbRest } from "@/lib/server/supabase";
import { getRoles } from "@/lib/roles";

const SITE = "https://www.transformertalent.com";
const MONTH = (iso: string) => {
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  const sameYear = iso.slice(0, 4) === new Date().toISOString().slice(0, 4);
  return d.toLocaleDateString("en-GB", { month: "long", ...(sameYear ? {} : { year: "numeric" }) });
};

// Everything the compose modal needs, in one round trip: the seat's
// connection state, the candidate's contact, the org's open roles (for the
// role merge + Insert job), templates (the quick-action defaults seeded on
// first use), the candidate's tracked link (minted here if it doesn't exist
// yet — same lazy scheme as the table), and the person-specific merge
// values: booking link, page link, matched roles, the month they asked for.
export async function POST(req: NextRequest) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  if (!emailConfigured()) return NextResponse.json({ error: "email_off" }, { status: 503 });

  let body: { candidateKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const key = String(body.candidateKey || "");
  const contact = await candidateContact(member.org.id, key);
  if (!contact) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await ensureDefaultTemplates(member.org.id, member.email).catch(() => {});

  const [account, jobs, templates, trackedLink, profile, app] = await Promise.all([
    accountFor(member.org.id, member.email),
    composeJobs(member.org.id, member.org.slug),
    listTemplates(member.org.id),
    trackedLinkUrl(member.org.id, key, member.userId),
    loadProfile(member.org.id, member.userId),
    key.startsWith("app_")
      ? sbRest(
          `website_applications?id=eq.${key.slice(4)}&organization_id=eq.${member.org.id}&select=role_ids,matched_role_ids,follow_up_at,source&limit=1`
        ).then(async (r) => (r.ok ? ((await r.json()) as { role_ids: string[] | null; matched_role_ids: string[] | null; follow_up_at: string | null; source: string | null }[])[0] || null : null))
      : Promise.resolve(null),
  ]);

  // {{sender_name}}: the seat's recruiter-page display name when they have
  // one; the email local part is a last resort, not a good look.
  const local = member.email.split("@")[0] || "";
  const senderName =
    profile?.display_name || (local ? local.charAt(0).toUpperCase() + local.slice(1) : "");

  // {{page_link}}: the seat's published page, else the org's board.
  const pageLink =
    profile?.published && profile.slug ? `${SITE}/r/${profile.slug}` : `${SITE}/board/${member.org.slug}`;

  // {{matched_roles}}: what the matcher attached (applied roles first), by
  // title, best first, at most three. TT site roles aren't org_roles rows.
  const wantIds = [...(app?.role_ids || []), ...(app?.matched_role_ids || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3);
  const titleOf = new Map(jobs.map((j) => [j.id, j.title]));
  // Only the TT org's own site roles live outside org_roles; another org's
  // ids must never resolve against them.
  if (member.org.slug === "transformer-talent" && wantIds.some((id) => !titleOf.has(id))) {
    for (const r of await getRoles().catch(() => [] as { jobId: string; title: string }[])) titleOf.set(r.jobId, r.title);
  }
  const matchedRoles = wantIds.map((id) => titleOf.get(id) || "").filter(Boolean);

  // The roles they actually APPLIED to, as opposed to the matcher's guesses.
  // Both quick actions on an application act on every one of these, so a role
  // that has CLOSED since they applied has to be here too: leaving it out
  // would skip its stage move and drop it from the email, which is exactly
  // the silent stranding this is meant to end. composeJobs only returns open
  // roles, so closed ones are looked up separately.
  const appliedIds = [...new Set(app?.role_ids || [])];
  const unresolved = appliedIds.filter((id) => !titleOf.has(id));
  if (unresolved.length) {
    const res = await sbRest(
      `org_roles?organization_id=eq.${member.org.id}&external_id=in.(${unresolved.map((s) => `"${s.replace(/"/g, "")}"`).join(",")})&select=external_id,title`
    ).catch(() => null);
    for (const r of res && res.ok ? ((await res.json()) as { external_id: string; title: string }[]) : []) {
      titleOf.set(r.external_id, r.title);
    }
  }
  const appliedRoles = appliedIds
    .map((id) => ({ id, title: titleOf.get(id) || "" }))
    .filter((r) => r.title);

  // {{referrer_name}}: who put them forward (the referral form's name, never
  // the email); empty for everyone who wasn't referred, so a template that
  // names a referrer shows a pill on the wrong person.
  const referrerName = ((app?.source || "").match(/^referral: by (.+?) <[^>]+>/) || [])[1]?.trim() || "";

  return NextResponse.json({
    connected: Boolean(account),
    address: account?.address || "",
    candidate: { name: contact.name, email: contact.email },
    senderName,
    jobs,
    templates,
    trackedLink,
    bookingLink: profile?.booking_url || "",
    pageLink,
    matchedRoles,
    appliedRoles,
    orgName: member.org.name,
    referrerName,
    month: app?.follow_up_at ? MONTH(app.follow_up_at) : "",
    appliedRoleId: (app?.role_ids || [])[0] || (app?.matched_role_ids || [])[0] || "",
  });
}
