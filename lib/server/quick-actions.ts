// Default templates for quick actions, seeded into an org's own template
// list ONCE (organizations.quick_templates_seeded_at). After that they are
// the org's: rename, reword, delete — a deleted one stays deleted, and the
// button then says the template is missing rather than sending a stale
// copy. A default added later carries `since`: it is seeded into orgs
// whose first seed predates it, once, and then follows the same rule. Quick actions find them by action_key, so renames don't matter.
// Candidate-facing copy: no em-dashes, plain sentences, nothing internal.
import { sbRest } from "./supabase";
import { listTemplates, createTemplate, setTemplateActionKey, type Template } from "./email-compose";
import { TEMPLATE } from "@/lib/quick-actions";
import { QUICK_BUTTONS, buttonByKey } from "@/lib/quick-buttons";

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

// ---- which template each button sends ---------------------------------------
// Default: the org's copy of the stock wording, found by action_key. A row in
// quick_action_templates points a button somewhere else; a row whose template
// is gone (deleted → null) falls back to the default again.

/** Resolved template id per button key (null = nothing to send). */
export async function resolveButtons(orgId: string, templates: Template[]): Promise<Record<string, string | null>> {
  const res = await sbRest(`quick_action_templates?organization_id=eq.${orgId}&select=button_key,template_id&limit=200`).catch(() => null);
  const rows = res && res.ok ? ((await res.json()) as { button_key: string; template_id: string | null }[]) : [];
  const mapped = new Map(rows.map((r) => [r.button_key, r.template_id]));
  const ids = new Set(templates.map((t) => t.id));
  const byKey = new Map<string, string>();
  for (const t of templates) if (t.actionKey && !byKey.has(t.actionKey)) byKey.set(t.actionKey, t.id);
  const out: Record<string, string | null> = {};
  for (const b of QUICK_BUTTONS) {
    const m = mapped.get(b.key);
    out[b.key] = m && ids.has(m) ? m : byKey.get(b.defaultKey) || null;
  }
  return out;
}

/** Point a button at a template (owner). templateId null = back to the default. */
export async function setButtonTemplate(orgId: string, byEmail: string, buttonKey: string, templateId: string | null): Promise<boolean> {
  if (!buttonByKey(buttonKey)) return false;
  if (!templateId) {
    const res = await sbRest(`quick_action_templates?organization_id=eq.${orgId}&button_key=eq.${encodeURIComponent(buttonKey)}`, { method: "DELETE" });
    return res.ok;
  }
  // The template must be this org's.
  const chk = await sbRest(`email_templates?id=eq.${templateId}&organization_id=eq.${orgId}&select=id&limit=1`);
  if (!chk.ok || ((await chk.json()) as unknown[]).length === 0) return false;
  const res = await sbRest(`quick_action_templates?on_conflict=organization_id,button_key`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ organization_id: orgId, button_key: buttonKey, template_id: templateId, updated_by_email: byEmail, updated_at: new Date().toISOString() }),
  });
  return res.ok;
}

/** Bring a deleted stock template back (a new row with the stock wording)
 *  and let its buttons fall back to it. Returns the template, or the
 *  existing one when nothing was missing. */
export async function restoreDefault(orgId: string, byEmail: string, defaultKey: string): Promise<Template | null> {
  const stock = DEFAULT_TEMPLATES.find((t) => t.key === defaultKey);
  if (!stock) return null;
  const have = await listTemplates(orgId);
  const existing = have.find((t) => t.actionKey === defaultKey);
  if (existing) return existing;
  // A renamed template may already own the stock name: give the restored copy a suffix.
  const taken = new Set(have.map((t) => t.name.trim().toLowerCase()));
  const name = taken.has(stock.name.toLowerCase()) ? `${stock.name} (default)` : stock.name;
  const made = await createTemplate({ orgId, name, subject: stock.subject, bodyHtml: stock.bodyHtml, byEmail, actionKey: stock.key });
  if ("error" in made) return null;
  // Buttons that pointed at the deleted copy fall back by themselves (null template_id).
  return made;
}

/** Every stock template that is missing, restored. Returns how many. */
export async function restoreAllDefaults(orgId: string, byEmail: string): Promise<number> {
  const have = await listTemplates(orgId);
  const keys = new Set(have.map((t) => t.actionKey).filter(Boolean));
  let n = 0;
  for (const t of DEFAULT_TEMPLATES) {
    if (keys.has(t.key)) continue;
    if (await restoreDefault(orgId, byEmail, t.key)) n++;
  }
  return n;
}
