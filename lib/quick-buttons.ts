// Every quick-action button that sends a template: where it appears, when,
// the stock template it starts with, what Send does afterwards, and the
// merge fields the composer can fill for it. Settings → Email templates
// lists these and lets the owner point any of them at any template.
// Keys are stable; the labels are what the button says.
import { TEMPLATE } from "./quick-actions";

export type QuickButton = {
  key: string;
  where: string;
  label: string;
  when: string;
  /** action_key of the stock template this button starts with. */
  defaultKey: string;
  then: string;
  /** Merge fields the composer can fill when this button opens it. */
  fields: string[];
};

const BASE = ["first_name", "full_name", "sender_name", "booking_link", "page_link", "tracked_link"];
const ROLE = ["job_title", "company", "role_link"];
const THREAD = ["subject"];

export const QUICK_BUTTONS: QuickButton[] = [
  { key: "inbox.app.call", where: "Inbox · Applied", label: "Schedule a call", when: "someone applied to a role", defaultKey: TEMPLATE.applyCall.key, then: "moves to Contacted", fields: [...BASE, ...ROLE] },
  { key: "inbox.app.no", where: "Inbox · Applied", label: "Not suitable", when: "someone applied to a role", defaultKey: TEMPLATE.notThisTime.key, then: "moves to Rejected · can reject without emailing", fields: [...BASE, ...ROLE] },
  { key: "inbox.drop.call", where: "Inbox · Resume drop", label: "Schedule a call", when: "a resume drop matched a role", defaultKey: TEMPLATE.rolesForYou.key, then: "moves to Contacted", fields: [...BASE, ...ROLE, "matched_roles"] },
  { key: "inbox.drop.file", where: "Inbox · Resume drop", label: "Keep on file", when: "a resume drop, any match", defaultKey: TEMPLATE.keepPosted.key, then: "clears the item", fields: [...BASE, "matched_roles"] },
  { key: "inbox.ref.call", where: "Inbox · Referred", label: "Schedule a call", when: "a referral matched a role", defaultKey: TEMPLATE.referredCall.key, then: "moves to Contacted", fields: [...BASE, ...ROLE, "matched_roles", "referrer_name"] },
  { key: "inbox.ref.file", where: "Inbox · Referred", label: "Keep in touch", when: "a referral, any match", defaultKey: TEMPLATE.referredKeep.key, then: "clears the item", fields: [...BASE, "matched_roles", "referrer_name"] },
  { key: "inbox.ask.ack", where: "Inbox · Asked to hear later", label: "Thanks, speak later", when: "a future-interest entry", defaultKey: TEMPLATE.speakLater.key, then: "clears the item · the dated follow-up stays", fields: [...BASE, "month"] },
  { key: "inbox.mail.call", where: "Inbox · Reply waiting", label: "Schedule a call", when: "a candidate replied", defaultKey: TEMPLATE.replyCall.key, then: "replies in thread · moves to Contacted", fields: [...BASE, ...ROLE, ...THREAD] },
  { key: "inbox.remind.nudge", where: "Inbox · No reply reminder", label: "Nudge", when: "a reply reminder came due", defaultKey: TEMPLATE.followUp.key, then: "replies in thread · next reminder set", fields: [...BASE, ...ROLE, ...THREAD] },
  { key: "inbox.cback.cback", where: "Inbox · Check-back", label: "Check back in", when: "a no-reply check-back came due", defaultKey: TEMPLATE.checkBack.key, then: "replies in thread · moves to Contacted", fields: [...BASE, ...ROLE, ...THREAD] },
  { key: "inbox.fdue.open", where: "Inbox · Follow-up due", label: "Here's what's open", when: "the month they asked for arrived", defaultKey: TEMPLATE.followUpOpen.key, then: "marks contacted", fields: [...BASE, "matched_roles", "month"] },
  { key: "home.contacted.nudge", where: "Home · Needs attention", label: "Nudge", when: "Contacted, no reply", defaultKey: TEMPLATE.followUp.key, then: "in thread when one exists · reply reminder set", fields: [...BASE, ...ROLE, ...THREAD] },
  { key: "home.interviewing.checkin", where: "Home · Needs attention", label: "Check in", when: "Interviewing, gone quiet", defaultKey: TEMPLATE.checkIn.key, then: "in thread when one exists · reply reminder set", fields: [...BASE, ...ROLE, ...THREAD] },
  { key: "home.offer.times", where: "Home · Needs attention", label: "Offer times", when: "Offer out, no answer", defaultKey: TEMPLATE.offerTimes.key, then: "in thread when one exists · reply reminder set", fields: [...BASE, ...ROLE, ...THREAD] },
];

export const buttonByKey = (key: string): QuickButton | undefined => QUICK_BUTTONS.find((b) => b.key === key);

/** Merge fields a template's wording uses, from its subject and body. */
export function fieldsUsed(subject: string, bodyHtml: string): string[] {
  const out = new Set<string>();
  for (const m of `${subject} ${bodyHtml}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

/** What each field fills, for the Insert field menu and the page's help. */
export const FIELD_HELP: [string, string][] = [
  ["first_name", "their first name"],
  ["full_name", "their full name"],
  ["sender_name", "your name from My page"],
  ["booking_link", "your booking link"],
  ["page_link", "your recruiter page"],
  ["tracked_link", "page link that counts opens"],
  ["job_title", "the role the button is about"],
  ["company", "that role's company"],
  ["role_link", "that role's public page"],
  ["matched_roles", "roles they match (drops, referrals, follow-ups)"],
  ["referrer_name", "who referred them (referrals only)"],
  ["month", "the month they asked to hear back"],
  ["subject", "the thread's subject (replies only)"],
];
