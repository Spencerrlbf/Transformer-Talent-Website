// How the report card writes its numbers and words. Shared by the facts
// block, the career list and the skills table so a year reads the same
// everywhere on the card.

/** A number of years as the card prints it: whole when whole, else to one
 *  decimal place, so 0.96 reads "1" and 1.25 reads "1.3". */
const num = (n: number) => (Number.isInteger(n) ? n : Number(n.toFixed(1)));

/** Under a year the card says months: 0.4 years is "5 months". Never under
 *  one month, and eleven and a half months round up to the year. */
const monthsOf = (n: number) => Math.max(1, Math.round(n * 12));
const underAYear = (n: number) => n < 1 && monthsOf(n) < 12;

/** "4.7 years", "1 year", "3 years". */
export const yearsWord = (n: number) => {
  const d = num(n);
  return `${d} ${d === 1 ? "year" : "years"}`;
};

/** "2.2 yrs", "1 yr": the short form beside a date range; under a year,
 *  "7 months". */
export const yearsShort = (n: number) => {
  if (underAYear(n)) return `${monthsOf(n)} ${monthsOf(n) === 1 ? "month" : "months"}`;
  const d = num(n);
  return `${d} ${d === 1 ? "yr" : "yrs"}`;
};

/** "2.2y", "3y": the shortest form, in a table column; under a year, "7 mo". */
export const yearsTiny = (n: number) => (underAYear(n) ? `${monthsOf(n)} mo` : `${num(n)}y`);

export const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

/** "~183 people", "~1.1k people", "~12k people". */
export const people = (n: number) => (n >= 1000 ? `~${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")}k people` : `~${n} people`);

/** The employer's stage or size, as far as its own page says: "startup ·
 *  ~183 people", "large company · ~12k people", "~1.1k people", or nothing. */
export function companySize(c: { employees: number | null; tag: "startup" | "large" | null } | null | undefined): string {
  if (!c) return "";
  const tag = c.tag === "startup" ? "startup" : c.tag === "large" ? "large company" : "";
  return [tag, c.employees != null ? people(c.employees) : ""].filter(Boolean).join(" · ");
}

/** A position that is still running: no end, or an end that says so. */
export const stillThere = (to: string | null | undefined) => !to || /^(present|now|current|today)$/i.test(to.trim());

/** The year a position ended, or began: "2022". */
export const yearOf = (from: string | null | undefined, to: string | null | undefined) => (to && to.match(/\d{4}/)?.[0]) || (from && from.match(/\d{4}/)?.[0]) || "";

/** "Bachelor of Science - BS" reads as "BS" beside the school's name; a
 *  degree written plainly ("MSc") stays as written. */
export const degreeShort = (degree: string | null | undefined) => {
  if (!degree) return "";
  const parts = degree.split(/\s[-–]\s/);
  const last = (parts.length > 1 ? parts[parts.length - 1] : degree).trim();
  return last.length <= 24 ? last : degree.trim();
};

export const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
