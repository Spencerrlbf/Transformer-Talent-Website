// Home goals + attention rules: the pure parts shared by the server (the
// counting) and the client (the cards and the Settings forms). Weeks start
// on Monday in the viewer's calendar; a target is "on pace" when what's done
// is at least the fraction of the working week already gone.

export const GOAL_KEYS = ["emails", "calls", "interviewing", "placements"] as const;
export type GoalKey = (typeof GOAL_KEYS)[number];
export type Targets = Record<GoalKey, number>;

export const GOAL_LABEL: Record<GoalKey, string> = {
  emails: "Emails sent",
  calls: "Calls done",
  interviewing: "Moved to Interviewing",
  placements: "Placements",
};
export const GOAL_SUB: Record<GoalKey, string> = {
  emails: "from your connected mailbox",
  calls: "call tasks marked done",
  interviewing: "stage moves you made",
  placements: "moved to Hired",
};
export const DEFAULT_TARGETS: Targets = { emails: 20, calls: 5, interviewing: 3, placements: 1 };

/** Whole numbers 0..999; anything else falls back to the given base. */
export function sanitizeTargets(v: unknown, base: Targets = DEFAULT_TARGETS): Targets {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out = { ...base };
  for (const k of GOAL_KEYS) {
    const n = Number(o[k]);
    if (Number.isFinite(n)) out[k] = Math.max(0, Math.min(999, Math.round(n)));
  }
  return out;
}

// ---- attention rules ---------------------------------------------------
export const RULE_KEYS = ["reply", "contacted", "interviewing", "offer", "role", "fdue"] as const;
export type RuleKey = (typeof RULE_KEYS)[number];
export type Rule = { on: boolean; days: number };
export type AttentionRules = Record<RuleKey, Rule>;

export const DEFAULT_RULES: AttentionRules = {
  reply: { on: true, days: 2 },
  contacted: { on: true, days: 10 },
  interviewing: { on: true, days: 10 },
  offer: { on: true, days: 5 },
  role: { on: true, days: 14 },
  fdue: { on: true, days: 7 },
};
export const RULE_LABEL: Record<RuleKey, string> = {
  reply: "Waiting for your reply",
  contacted: "Contacted, no reply",
  interviewing: "Interviewing, no activity",
  offer: "Offer out, no answer",
  role: "Role with no new applicants",
  fdue: "Follow-ups due soon",
};
export const RULE_HINT: Record<RuleKey, string> = {
  reply: "a candidate replied and nobody has answered them",
  contacted: "a backstop; reply reminders catch these sooner",
  interviewing: "activity = a stage move, an email either way, a task done or a note",
  offer: "days since the offer went out with no activity",
  role: "no application and no sourcing import in this long",
  fdue: "people who asked to hear from you within this many days",
};

export function sanitizeRules(v: unknown): AttentionRules {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out = {} as AttentionRules;
  for (const k of RULE_KEYS) {
    const r = (o[k] && typeof o[k] === "object" ? o[k] : {}) as Record<string, unknown>;
    const days = Number(r.days);
    out[k] = {
      on: typeof r.on === "boolean" ? r.on : DEFAULT_RULES[k].on,
      days: Number.isFinite(days) ? Math.max(1, Math.min(90, Math.round(days))) : DEFAULT_RULES[k].days,
    };
  }
  return out;
}

// ---- week maths (YYYY-MM-DD strings, no timezone) -------------------------
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Monday of the week `today` is in. */
export function weekStart(today: string): string {
  const d = at(today);
  const wd = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((wd + 6) % 7));
  return iso(d);
}

/** How much of the five-day working week is already gone, 0..1:
 *  Monday 0, Tuesday .2, Wednesday .4, Thursday .6, Friday .8, weekend 1. */
export function paceFraction(today: string): number {
  const wd = at(today).getUTCDay();
  if (wd === 0 || wd === 6) return 1;
  return (wd - 1) / 5;
}

/** Working days still to come this week, today included (Wednesday = 3). */
export function workingDaysLeft(today: string): number {
  const wd = at(today).getUTCDay();
  if (wd === 0 || wd === 6) return 0;
  return 6 - wd;
}

export type GoalState = "done" | "on" | "behind";
export function goalState(n: number, target: number, pace: number): GoalState {
  if (target <= 0 || n >= target) return "done";
  return n / target >= pace ? "on" : "behind";
}

/** "3 to go · 1 a day keeps pace" / "target met" / "3 to go". */
export function goalHint(n: number, target: number, today: string): string {
  if (target <= 0 || n >= target) return "target met";
  const left = target - n;
  const days = workingDaysLeft(today);
  if (days === 0) return `${left} to go`;
  const perDay = Math.ceil(left / days);
  return `${left} to go · ${perDay} a day keeps pace`;
}

/** "Week of 1 Sep" */
export function weekLabel(monday: string): string {
  return `Week of ${at(monday).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
}
