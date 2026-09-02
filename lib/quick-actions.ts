// Quick actions: the rules that give each kind of Inbox item its buttons.
// A button never sends. It opens the composer with a template merged for
// the person; Send does the bookkeeping named in `stage`, and only on the
// item's own role — never on whatever role the merge fields happen to show.
// Templates are found by a stable key on the org's own template (seeded
// once per org, renamable, editable); the name is a fallback for older rows.
export type QuickStage = "contacted" | "rejected";

export type QuickAction = {
  id: string;
  label: string;
  /** Stable key of the template in the org's list; null = the plain composer. */
  template: string | null;
  /** The default template's name (lookup fallback + the button's tooltip). */
  templateName?: string;
  /** Pipeline move made after a successful Send — only when the item names a role. */
  stage?: QuickStage;
  primary?: boolean;
  danger?: boolean;
  /** Offers "Reject without emailing" inside the composer. */
  allowSilent?: boolean;
  /** Sent as a reply inside the open thread. */
  reply?: boolean;
  /** Composer default for "remind me if no reply": false = start on Off. */
  remind?: boolean;
};

export const TEMPLATE = {
  applyCall: { key: "apply_call", name: "Thanks for applying, book a call" },
  rolesForYou: { key: "roles_for_you", name: "We have roles for you" },
  keepPosted: { key: "keep_posted", name: "Keeping you posted" },
  referredCall: { key: "referred_call", name: "Referred, book a call" },
  referredKeep: { key: "referred_keep", name: "Referred, keep in touch" },
  notThisTime: { key: "not_this_time", name: "Not this time" },
  speakLater: { key: "speak_later", name: "Thanks, speak later" },
  replyCall: { key: "reply_call", name: "Book a call (reply)" },
  followUpOpen: { key: "follow_up_open", name: "Follow-up: what's open" },
  followUp: { key: "follow_up_nudge", name: "Following up" },
} as const;

const REPLY: QuickAction = { id: "reply", label: "Reply…", template: null };
const t = (x: { key: string; name: string }) => ({ template: x.key, templateName: x.name });

/** The buttons for one item. hasRole = a role to move (applied or matched). */
export function actionsFor(
  kind: string,
  ctx: { hasRole: boolean; month?: string | null }
): QuickAction[] {
  switch (kind) {
    case "app":
      return [
        { id: "call", label: "Schedule a call", ...t(TEMPLATE.applyCall), stage: "contacted", primary: true },
        { id: "no", label: "Not suitable", ...t(TEMPLATE.notThisTime), stage: "rejected", danger: true, allowSilent: true, remind: false },
        REPLY,
      ];
    case "drop":
      return ctx.hasRole
        ? [
            { id: "call", label: "Schedule a call", ...t(TEMPLATE.rolesForYou), stage: "contacted", primary: true },
            { id: "file", label: "Keep on file", ...t(TEMPLATE.keepPosted), remind: false },
            REPLY,
          ]
        : [{ id: "file", label: "Keep on file", ...t(TEMPLATE.keepPosted), remind: false, primary: true }, REPLY];
    // A referred person sent nothing themselves: the email names who put
    // them forward and asks for the resume the referral form never collects.
    case "ref":
      return ctx.hasRole
        ? [
            { id: "call", label: "Schedule a call", ...t(TEMPLATE.referredCall), stage: "contacted", primary: true },
            { id: "file", label: "Keep in touch", ...t(TEMPLATE.referredKeep), remind: false },
            REPLY,
          ]
        : [{ id: "file", label: "Keep in touch", ...t(TEMPLATE.referredKeep), remind: false, primary: true }, REPLY];
    case "ask":
      return [
        { id: "ack", label: ctx.month ? `Thanks, speak in ${ctx.month}` : "Thanks, speak later", ...t(TEMPLATE.speakLater), primary: true, remind: false },
        REPLY,
      ];
    case "mail":
      return [
        { id: "call", label: "Schedule a call", ...t(TEMPLATE.replyCall), stage: "contacted", primary: true, reply: true },
        { ...REPLY, reply: true },
      ];
    // A reply reminder came due: nudge in the same thread (Send sets the
    // next one), or let go. Every button opens the composer first.
    case "remind":
      return [
        { id: "nudge", label: "Nudge", ...t(TEMPLATE.followUp), primary: true, reply: true },
        { id: "no", label: "Not this time", ...t(TEMPLATE.notThisTime), stage: "rejected", danger: true, allowSilent: true, remind: false },
        { ...REPLY, reply: true },
      ];
    case "fdue":
      return [
        { id: "open", label: "Here's what's open", ...t(TEMPLATE.followUpOpen), primary: true },
        REPLY,
      ];
    default:
      return [];
  }
}

/** Plain-English outcome for the composer's "Then:" line and the strip.
 *  hasRole = the item names a role the move can land on. */
export function outcomeLabel(a: QuickAction, kind: string, hasRole = true): string {
  const clears = kind === "mail" ? "thread clears" : "item clears";
  if (kind === "remind") {
    if (a.id === "nudge") return "next reminder set · item clears";
    if (a.stage === "rejected") return hasRole ? "stage moves to Rejected · reminder ends" : "reminder ends · no role to move";
    return "reminder ends · item clears";
  }
  if (a.stage === "contacted") return hasRole ? `stage moves to Contacted · ${clears}` : `${clears} · no role to move`;
  if (a.stage === "rejected") return hasRole ? `stage moves to Rejected · ${clears}` : `${clears} · no role to move`;
  if (kind === "fdue") return "marked contacted · follow-up clears";
  if (kind === "ask") return "item clears · the dated follow-up stays";
  return clears;
}
