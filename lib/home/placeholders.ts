// Every number the homepage shows lives here. A null means "not measured
// yet": the page renders a visible "measuring" state instead of a figure.
// Nothing here is a promise; measured values are reported as medians.

/** Profiles in a first shortlist. [placeholder, confirm from first batches] */
export const SHORTLIST_SIZE = 5;

/** Hours from brief received to first profile shared, across closed roles.
 *  Written by scripts/measure-first-answers.mjs into data/first-answers.json. */
export const FIRST_PROFILE_HOURS: { p50: number | null; p90: number | null } = {
  p50: null,
  p90: null,
};

/** Share of first answers that were a market read rather than a profile. */
export const MARKET_READ_SHARE: number | null = null;

/** Hours saved on a second role at the same company. [placeholder, measure] */
export const WARM_START_DELTA_HOURS: number | null = null;

/** Closed roles needed before the time-to-first-profile curve renders. */
export const CDF_MIN_ROLES = 10;

/** Announcement bar with the live role count. Off until Spencer says yes. */
export const SHOW_ROLE_COUNT_BANNER = false;

const WORDS: Record<number, string> = { 5: "Five", 500: "five hundred" };
/** Number words for headings; falls back to digits for unmapped values. */
export function numberWord(n: number): string {
  return WORDS[n] ?? String(n);
}
