// Loader for the time-to-first-profile figures on the homepage. Reads
// data/first-answers.json, written by scripts/measure-first-answers.mjs
// (build step 10), and turns it into the three tile figures and the hours
// behind the curve. Server side only: it touches the filesystem. It never
// throws at render; an absent or malformed file yields the measuring state.
//
// File shape:
// {
//   measuredAt: string,                       ISO timestamp of the measurement run
//   roles: [{
//     roleId: string,
//     briefReceivedAt: string,                ISO, the role's created timestamp
//     firstAnswerAt: string,                  ISO, first profile shared or first market read
//     kind: "profile" | "market_read"
//   }]
// }
import { promises as fs } from "node:fs";
import path from "node:path";
import { CDF_MIN_ROLES } from "./placeholders";

export type FirstAnswerKind = "profile" | "market_read";

export type FirstAnswerRole = {
  roleId: string;
  briefReceivedAt: string;
  firstAnswerAt: string;
  kind: FirstAnswerKind;
};

export type FirstAnswersFile = {
  measuredAt: string;
  roles: FirstAnswerRole[];
};

export type FirstAnswers = {
  /** True once at least CDF_MIN_ROLES closed roles are in the file. */
  ready: boolean;
  /** Closed roles in the file, profiles and market reads together. */
  count: number;
  /** Median hours from brief received to first profile shared; null until ready. */
  p50: number | null;
  /** p90 of the same; null until ready. */
  p90: number | null;
  /** Share of first answers that were a market read, 0 to 1; null until ready. */
  readShare: number | null;
  /** Hours to first profile per role whose first answer was a profile, sorted ascending. */
  hours: number[];
  /** The file's measuredAt, or null when the file is absent or invalid. */
  measuredAt: string | null;
};

export const FIRST_ANSWERS_PATH = path.join("data", "first-answers.json");

const EMPTY: FirstAnswers = {
  ready: false,
  count: 0,
  p50: null,
  p90: null,
  readShare: null,
  hours: [],
  measuredAt: null,
};

const KINDS: ReadonlySet<string> = new Set<FirstAnswerKind>(["profile", "market_read"]);
const MS_PER_HOUR = 60 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

function isRole(v: unknown): v is FirstAnswerRole {
  if (!isRecord(v)) return false;
  if (typeof v.roleId !== "string" || !v.roleId) return false;
  if (!isIsoDate(v.briefReceivedAt) || !isIsoDate(v.firstAnswerAt)) return false;
  if (typeof v.kind !== "string" || !KINDS.has(v.kind)) return false;
  return Date.parse(v.firstAnswerAt) >= Date.parse(v.briefReceivedAt);
}

/** Shape check for the file as parsed. Exported so the stub script and tests can share it. */
export function isFirstAnswersFile(v: unknown): v is FirstAnswersFile {
  return isRecord(v) && typeof v.measuredAt === "string" && Array.isArray(v.roles) && v.roles.every(isRole);
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1];
}

/** Pure part of the loader: figures from an already validated file. */
export function summarize(file: FirstAnswersFile): FirstAnswers {
  const count = file.roles.length;
  const hours = file.roles
    .filter((r) => r.kind === "profile")
    .map((r) => (Date.parse(r.firstAnswerAt) - Date.parse(r.briefReceivedAt)) / MS_PER_HOUR)
    .sort((a, b) => a - b);
  // The hour figures and the curve rest on the profile sample; the read share on every closed role.
  const ready = hours.length >= CDF_MIN_ROLES;
  const reads = file.roles.filter((r) => r.kind === "market_read").length;
  return {
    ready,
    count,
    p50: ready ? percentile(hours, 0.5) : null,
    p90: ready ? percentile(hours, 0.9) : null,
    readShare: count >= CDF_MIN_ROLES ? reads / count : null,
    hours,
    measuredAt: file.measuredAt,
  };
}

/**
 * Reads and summarizes data/first-answers.json. Resolves to the measuring
 * state (ready false, null figures) when the file is absent, unreadable or
 * not of the expected shape. Never rejects.
 */
export async function loadFirstAnswers(file: string = FIRST_ANSWERS_PATH): Promise<FirstAnswers> {
  try {
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const raw = await fs.readFile(abs, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isFirstAnswersFile(parsed)) return EMPTY;
    return summarize(parsed);
  } catch {
    return EMPTY;
  }
}
