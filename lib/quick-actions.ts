// Quick actions: the rules that give each kind of Inbox item its buttons.
// A button never sends. It opens the composer with a named template merged
// for the person; Send does the bookkeeping named in `stage`. Shared by
// the Inbox strip (client) and the send route (server), so both read the
// same rule. Templates are looked up by name in the org's own list (seeded
// once per org, editable like any other).
export type QuickStage = "contacted" | "rejected";

export type QuickAction = {
  id: string;
  label: string;
  /** Template name in the org's list; null = the plain composer. */
  template: string | null;
  /** Pipeline move made after a successful Send. */
  stage?: QuickStage;
  primary?: boolean;
  danger?: boolean;
  /** Offers "Reject without emailing" inside the composer. */
  allowSilent?: boolean;
  /** Sent as a reply inside the open thread. */
  reply?: boolean;
};

export const TEMPLATE = {
  applyCall: "Thanks for applying, book a call",
  rolesForYou: "We have roles for you",
  keepPosted: "Keeping you posted",
  notThisTime: "Not this time",
  speakLater: "Thanks, speak later",
  replyCall: "Book a call (reply)",
  followUpOpen: "Follow-up: what's open",
} as const;

const REPLY: QuickAction = { id: "reply", label: "Reply…", template: null };

/** The buttons for one item. hasRole = a role to move (applied or matched). */
export function actionsFor(
  kind: string,
  ctx: { hasRole: boolean; month?: string | null }
): QuickAction[] {
  switch (kind) {
    case "app":
      return [
        { id: "call", label: "Schedule a call", template: TEMPLATE.applyCall, stage: "contacted", primary: true },
        { id: "no", label: "Not suitable", template: TEMPLATE.notThisTime, stage: "rejected", danger: true, allowSilent: true },
        REPLY,
      ];
    case "drop":
    case "ref":
      return ctx.hasRole
        ? [
            { id: "call", label: "Schedule a call", template: TEMPLATE.rolesForYou, stage: "contacted", primary: true },
            { id: "file", label: "Keep on file", template: TEMPLATE.keepPosted },
            REPLY,
          ]
        : [{ id: "file", label: "Keep on file", template: TEMPLATE.keepPosted, primary: true }, REPLY];
    case "ask":
      return [
        { id: "ack", label: ctx.month ? `Thanks, speak in ${ctx.month}` : "Thanks, speak later", template: TEMPLATE.speakLater, primary: true },
        REPLY,
      ];
    case "mail":
      return [
        { id: "call", label: "Schedule a call", template: TEMPLATE.replyCall, stage: "contacted", primary: true, reply: true },
        { ...REPLY, reply: true },
      ];
    case "fdue":
      return [
        { id: "open", label: "Here's what's open", template: TEMPLATE.followUpOpen, primary: true },
        REPLY,
      ];
    default:
      return [];
  }
}

/** Plain-English outcome for the composer's "Then:" line and the strip. */
export function outcomeLabel(a: QuickAction, kind: string): string {
  if (a.stage === "contacted") return kind === "mail" ? "stage moves to Contacted · thread clears" : "stage moves to Contacted · item clears";
  if (a.stage === "rejected") return "stage moves to Rejected · item clears";
  if (kind === "fdue") return "marked contacted · follow-up clears";
  if (kind === "ask") return "item clears · the dated follow-up stays";
  return "item clears";
}
