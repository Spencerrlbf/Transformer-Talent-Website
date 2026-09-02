// Client-side mirror of lib/server/inbox.ts types (the API's JSON shape).
export type InboxKind =
  | "mail" | "temail" | "tcall" | "tmsg" | "ttask"
  | "app" | "drop" | "ref" | "ask" | "fdue";
export type InboxSection = "emails" | "calls" | "messages" | "new" | "fdue" | "other";
export type InboxScope = "me" | "team";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  section: InboxSection;
  candidateKey: string | null;
  candidateName: string;
  title: string;
  detail: string;
  at: string;
  dueDate: string | null;
  dueTime: string | null;
  overdue: boolean;
  seen: boolean;
  forEmail: string | null;
  jobId: string | null;
  threadId: string | null;
  taskId: string | null;
  subject: string | null;
  extra: string | null;
  /** One row per person: the person's other open items ride along here. */
  also?: AlsoItem[];
};

export type AlsoItem = {
  id: string;
  kind: InboxKind;
  title: string;
  taskId: string | null;
  threadId: string | null;
  jobId: string | null;
  overdue: boolean;
};

export type InboxDone = {
  id: string;
  kind: InboxKind | "task";
  title: string;
  candidateKey: string | null;
  candidateName: string;
  reason: string;
  at: string;
  forEmail: string | null;
};

export type InboxData = {
  scope: InboxScope;
  today: string;
  items: InboxItem[];
  upcoming: { day: string; items: InboxItem[] }[];
  done: InboxDone[];
  counts: { today: number; overdue: number; upcoming: number; done: number };
  emailVisibility: "private" | "team";
};

export const SECTION_ORDER: InboxSection[] = ["emails", "calls", "messages", "new", "fdue", "other"];
export const SECTION_TITLE: Record<InboxSection, string> = {
  emails: "Emails",
  calls: "Calls",
  messages: "Messages",
  new: "New people",
  fdue: "Follow-ups due",
  other: "Other tasks",
};
export const SECTION_WHY: Record<InboxSection, string> = {
  emails: "replies waiting and emails you planned",
  calls: "calls you planned",
  messages: "LinkedIn and other messages you planned",
  new: "arrived since you last cleared",
  fdue: "asked to hear from you by now",
  other: "",
};
export const KIND_LABEL: Record<InboxKind, string> = {
  mail: "Email",
  temail: "Task · email",
  tcall: "Task · call",
  tmsg: "Task · message",
  ttask: "Task",
  app: "Applied",
  drop: "Resume drop",
  ref: "Referred",
  ask: "Asked",
  fdue: "Follow-up due",
};
/** KindIcon name for each inbox kind. */
export const KIND_ICON: Record<InboxKind, string> = {
  mail: "email",
  temail: "email",
  tcall: "call",
  tmsg: "message",
  ttask: "task",
  app: "applied",
  drop: "drop",
  ref: "referred",
  ask: "request",
  fdue: "request",
};
/** Colour family for the row icon / pill / strip. */
export const KIND_TONE: Record<InboxKind, "mail" | "new" | "ask" | "task"> = {
  mail: "mail",
  temail: "mail",
  tcall: "task",
  tmsg: "task",
  ttask: "task",
  app: "new",
  drop: "new",
  ref: "new",
  ask: "ask",
  fdue: "ask",
};

export const isTask = (k: InboxKind) => k === "temail" || k === "tcall" || k === "tmsg" || k === "ttask";

/** Human reason for the Done view and the drawer strip. */
export function reasonLabel(reason: string, kind?: InboxKind | "task"): string {
  if (reason.startsWith("stage:")) return `moved to ${reason.slice(6)}`;
  switch (reason) {
    case "reply":
      return "you replied";
    case "email":
      return kind === "temail" ? "email sent, task done" : "email sent";
    case "contacted":
      return "marked contacted";
    case "task_done":
      return "task done";
    case "gone":
      return "no longer in your Inbox";
    default:
      return kind && (kind === "task" || isTask(kind as InboxKind)) ? "task done" : "marked done";
  }
}

/** Where a click lands in the drawer. */
export function landingTab(kind: InboxKind): "profile" | "pipeline" | "email" {
  if (kind === "mail" || kind === "temail") return "email";
  if (kind === "app" || kind === "drop") return "pipeline";
  return "profile";
}

export function stripHint(item: InboxItem): string {
  switch (item.kind) {
    case "app":
    case "drop":
      return "set a stage to clear this";
    case "ref":
    case "ask":
      return "email them or mark done";
    case "fdue":
      return "email them, or mark contacted";
    case "mail":
      return "reply to clear this";
    case "temail":
      return "sending the email completes the task";
    case "tcall":
      return "phone is in the contact block · mark done when you've called";
    case "tmsg":
      return "LinkedIn link is in the contact block · mark done when sent";
    default:
      return "";
  }
}
