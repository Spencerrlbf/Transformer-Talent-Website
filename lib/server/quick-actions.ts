// Default templates for quick actions, seeded into an org's own template
// list ONCE (organizations.quick_templates_seeded_at). After that they are
// the org's: rename, reword, delete — a deleted one stays deleted, and the
// button then says the template is missing rather than sending a stale
// copy. A default added later carries `since`: it is seeded into orgs
// whose first seed predates it, once, and then follows the same rule. Quick actions find them by action_key, so renames don't matter.
// Candidate-facing copy: no em-dashes, plain sentences, nothing internal.
import { sbRest } from "./supabase";
import { listTemplates, createTemplate, setTemplateActionKey } from "./email-compose";
import { TEMPLATE } from "@/lib/quick-actions";

const lines = (...ls: string[]) => ls.map((l) => (l ? `<div>${l}</div>` : "<div><br></div>")).join("");

export const DEFAULT_TEMPLATES: { key: string; name: string; subject: string; bodyHtml: string; since?: string }[] = [
  {
    ...TEMPLATE.applyCall,
    subject: "Your application for {{job_title}}",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Thanks for applying for the {{job_title}} role. I've read your profile and would like to talk.",
      "",
      "Pick a time that suits you here: {{booking_link}}",
      "The role and the team are on my page: {{page_link}}",
      "",
      "Looking forward to it,",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.rolesForYou,
    subject: "Thanks for your resume, a couple of roles to look at",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Thanks for sending your resume. A couple of open roles look like a strong fit: {{matched_roles}}.",
      "",
      "Book a call and I'll walk you through them: {{booking_link}}",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.keepPosted,
    subject: "Thanks for your resume",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Thanks for sending your resume. Nothing is the right fit today, but your profile is on file and I'll come back to you as soon as something matches.",
      "",
      "You can see what's open at any time here: {{page_link}}",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.referredCall,
    since: "2026-09-03T00:00:00Z",
    subject: "{{referrer_name}} suggested we talk",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "{{referrer_name}} passed your name to me and suggested we speak. I've had a look at your profile and a couple of open roles look like a strong fit: {{matched_roles}}.",
      "",
      "Pick a time that suits you here: {{booking_link}}",
      "The roles and the team are on my page: {{page_link}}",
      "",
      "I only have your LinkedIn so far. Could you reply with your resume, so I have the full picture before we speak?",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.referredKeep,
    since: "2026-09-03T00:00:00Z",
    subject: "{{referrer_name}} passed your name to me",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "{{referrer_name}} passed your name to me. Nothing open right now is quite right, but your profile is on file and I'll come back to you as soon as something matches.",
      "",
      "I only have your LinkedIn so far. Could you reply with your resume, so I can match you properly when the right role comes up?",
      "",
      "You can see what's open at any time here: {{page_link}}",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.notThisTime,
    subject: "Your application for {{job_title}}",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Thank you for applying for the {{job_title}} role. I won't be taking your application forward this time.",
      "",
      "I'll keep your profile on file and get in touch if a closer match comes up.",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.speakLater,
    subject: "Speak in {{month}}",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Thanks for getting in touch and telling me what you're after. I'll come back to you in {{month}} with roles that match.",
      "",
      "If anything changes before then, just reply here.",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.replyCall,
    subject: "Re: {{subject}}",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Great, let's talk. Pick a time here and I'll take it from there: {{booking_link}}",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.followUp,
    since: "2026-09-03T00:00:00Z",
    subject: "Re: {{subject}}",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Making sure this didn't get buried. I'd still like to talk if you're interested.",
      "",
      "Pick a time that suits you here: {{booking_link}}",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.checkBack,
    since: "2026-09-03T12:00:00Z",
    subject: "Re: {{subject}}",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "Checking back in, in case the timing is better now. I'd still like to talk if you're interested.",
      "",
      "Pick a time that suits you here: {{booking_link}}",
      "",
      "{{sender_name}}"
    ),
  },
  // Home "Needs attention": a check-in on someone quiet mid-process, and a
  // nudge to talk when an offer is out. Sent in their thread when one exists.
  {
    ...TEMPLATE.checkIn,
    since: "2026-09-03T15:00:00Z",
    subject: "How did it go?",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "How did the last conversation with the team go? I'd like to hear your side before we plan the next step.",
      "",
      "Reply here, or grab a few minutes with me: {{booking_link}}",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.offerTimes,
    since: "2026-09-03T15:00:00Z",
    subject: "Your offer: a few times to talk",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "I'd like to talk through the offer and answer anything that's on your mind.",
      "",
      "Pick a time that suits you here: {{booking_link}}",
      "",
      "If none of those work, reply with a couple of times and I'll fit around you.",
      "",
      "{{sender_name}}"
    ),
  },
  {
    ...TEMPLATE.followUpOpen,
    subject: "As promised, what's open now",
    bodyHtml: lines(
      "Hi {{first_name}},",
      "",
      "You asked me to come back to you in {{month}}, so here I am. Roles that match what you told me are open now: {{matched_roles}}.",
      "",
      "Shall we find 20 minutes? {{booking_link}}",
      "",
      "{{sender_name}}"
    ),
  },
];

/** Seed the defaults once per org. Existing templates that carry a default's
 *  name (seeded before keys existed) get their key stamped; nothing else is
 *  ever touched, and a deleted default stays deleted. */
export async function ensureDefaultTemplates(orgId: string, byEmail: string): Promise<void> {
  const res = await sbRest(`organizations?id=eq.${orgId}&select=quick_templates_seeded_at`);
  const [org] = res.ok ? ((await res.json()) as { quick_templates_seeded_at: string | null }[]) : [];
  const have = await listTemplates(orgId);

  // Stamp keys onto same-named templates that predate the key column.
  for (const t of DEFAULT_TEMPLATES) {
    const existing = have.find((x) => !x.actionKey && x.name.trim().toLowerCase() === t.name.toLowerCase());
    if (existing) await setTemplateActionKey(orgId, existing.id, t.key).catch(() => {});
  }
  const seededAt = org?.quick_templates_seeded_at || null;
  const due = DEFAULT_TEMPLATES.filter((t) => !seededAt || (t.since && t.since > seededAt));
  if (due.length === 0) return;

  const keyed = new Set(have.map((x) => x.actionKey || x.name.trim().toLowerCase()));
  for (const t of due) {
    if (keyed.has(t.key) || keyed.has(t.name.toLowerCase())) continue;
    await createTemplate({ orgId, name: t.name, subject: t.subject, bodyHtml: t.bodyHtml, byEmail, actionKey: t.key }).catch(() => null);
  }
  await sbRest(`organizations?id=eq.${orgId}`, {
    method: "PATCH",
    body: JSON.stringify({ quick_templates_seeded_at: new Date().toISOString() }),
    prefer: "return=minimal",
  }).catch(() => {});
}
