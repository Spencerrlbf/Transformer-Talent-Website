// Reply reminders: the date arithmetic shared by the composer (the preview
// under the chips), the send route (the real thing) and the Email tab
// (Change). Calendar days from the day you send; a day that lands on a
// weekend shows on the following Monday. No timezone maths: days are the
// viewer's local YYYY-MM-DD strings throughout.
export const REMIND_DAYS = [2, 3, 5, 7] as const;
export type RemindChoice = { days: number } | { date: string } | null;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const at = (day: string) => new Date(`${day}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
  const d = at(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}

/** Saturday → Monday, Sunday → Monday, anything else unchanged. */
export function rollWeekend(day: string): string {
  const wd = at(day).getUTCDay();
  if (wd === 6) return addDays(day, 2);
  if (wd === 0) return addDays(day, 1);
  return day;
}

/** The day a reminder lands, or null for "no reminder" / an invalid choice.
 *  A picked date must be after today. */
export function reminderDue(today: string, choice: RemindChoice): string | null {
  if (!choice || !DATE_RE.test(today)) return null;
  if ("date" in choice) {
    return DATE_RE.test(choice.date) && choice.date > today ? rollWeekend(choice.date) : null;
  }
  return (REMIND_DAYS as readonly number[]).includes(choice.days) ? rollWeekend(addDays(today, choice.days)) : null;
}

/** The wire shape from the composer: {days: 3} | {date: "2026-09-12"} | null. */
export function parseRemind(v: unknown): RemindChoice {
  if (!v || typeof v !== "object") return null;
  const o = v as { days?: unknown; date?: unknown };
  if (typeof o.days === "number" && (REMIND_DAYS as readonly number[]).includes(o.days)) return { days: o.days };
  if (typeof o.date === "string" && DATE_RE.test(o.date)) return { date: o.date };
  return null;
}

/** "Thu 4 Sep" */
export function fmtDue(day: string): string {
  return at(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** Whole days from a to b (b later = positive). */
export function daysBetween(a: string, b: string): number {
  return Math.round((at(b).getTime() - at(a).getTime()) / 86400_000);
}

/** The viewer's local calendar day. */
export const localDay = () => new Date().toLocaleDateString("en-CA");
