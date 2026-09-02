// Default templates for quick actions, seeded into an org's own template
// list the first time the composer loads for a seat. Once seeded they are
// the org's: rename, reword, delete. Quick actions look them up by name,
// so an edited version is what goes out. Candidate-facing copy: no em-
// dashes, plain sentences, nothing about internal tooling.
import { listTemplates, createTemplate } from "./email-compose";
import { TEMPLATE } from "@/lib/quick-actions";

const lines = (...ls: string[]) => ls.map((l) => (l ? `<div>${l}</div>` : "<div><br></div>")).join("");

export const DEFAULT_TEMPLATES: { name: string; subject: string; bodyHtml: string }[] = [
  {
    name: TEMPLATE.applyCall,
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
    name: TEMPLATE.rolesForYou,
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
    name: TEMPLATE.keepPosted,
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
    name: TEMPLATE.notThisTime,
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
    name: TEMPLATE.speakLater,
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
    name: TEMPLATE.replyCall,
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
    name: TEMPLATE.followUpOpen,
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

/** Add any default the org doesn't have yet (matched by name, case-
 *  insensitive). Never touches a template that exists. */
export async function ensureDefaultTemplates(orgId: string, byEmail: string): Promise<void> {
  const have = new Set((await listTemplates(orgId)).map((t) => t.name.trim().toLowerCase()));
  for (const t of DEFAULT_TEMPLATES) {
    if (have.has(t.name.toLowerCase())) continue;
    await createTemplate({ orgId, name: t.name, subject: t.subject, bodyHtml: t.bodyHtml, byEmail }).catch(() => null);
  }
}
