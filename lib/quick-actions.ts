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
  /** Opens the "Mark no reply" panel instead of the composer. */
  noReply?: boolean;
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
  checkBack: { key: "check_back", name: "Checking back in" },
  checkIn: { key: "check_in", name: "How did it go" },
  offerTimes: { key: "offer_times", name: "Offer times" },
} as const;

const REPLY: QuickAction = { id: "reply", label: "Reply…", template: null };
const NO_REPLY: QuickAction = { id: "noreply", label: "No reply", template: null, noReply: true };
const t = (x: { key: string; name: string }) => ({ template: x.key, templateName: x.name });

/** The buttons for one item. hasRole = a role to move (applied or matched). */
export function actionsFor(
  kind: string,
  ctx: { hasRole: boolean; month?: string | null; nudges?: number }
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
        NO_REPLY,
      ];
    // A reply reminder came due: nudge in the same thread (Send sets the
    // next one), or mark no reply. After two nudges, No reply leads.
    case "remind": {
      const tired = (ctx.nudges || 0) >= 2;
      return [
        { id: "nudge", label: "Nudge", ...t(TEMPLATE.followUp), primary: !tired, reply: true },
        { ...REPLY, reply: true },
        { ...NO_REPLY, primary: tired },
      ];
    }
    // A check-back came due: pick the conversation up again, or push it out.
    case "cback":
      return [
        { id: "cback", label: "Check back in", ...t(TEMPLATE.checkBack), stage: "contacted", primary: true, reply: true },
        { ...REPLY, reply: true },
        NO_REPLY,
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
  if (a.noReply) return hasRole ? `marked no reply · moves to Past on the role · ${clears}` : `marked no reply · ${clears}`;
  if (kind === "remind") {
    if (a.id === "nudge") return "next reminder set · item clears";
    return "reminder ends · item clears";
  }
  if (kind === "cback") {
    if (a.id === "cback") return hasRole ? "mark clears · stage moves to Contacted · item clears" : "mark clears · item clears";
    return "mark clears · item clears";
  }
  if (a.stage === "contacted") return hasRole ? `stage moves to Contacted · ${clears}` : `${clears} · no role to move`;
  if (a.stage === "rejected") return hasRole ? `stage moves to Rejected · ${clears}` : `${clears} · no role to move`;
  if (kind === "fdue") return "marked contacted · follow-up clears";
  if (kind === "ask") return "item clears · the dated follow-up stays";
  return clears;
}
