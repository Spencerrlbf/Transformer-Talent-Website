// Client-facing presentation of a scorecard: a friendly tag and a
// plain-English reason a founder can read. Pure code over the scorecard's
// structured fields — no LLM, and none of the internal shorthand or evidence
// trail ever crosses this boundary.
import type { Scorecard } from "./scorecard";

export type ClientTag = "strong" | "possible" | "stretch";

export const TAG_LABEL: Record<ClientTag, string> = {
  strong: "Strong fit",
  possible: "Worth a look",
  stretch: "Likely a stretch",
};

export function clientTag(sc: Scorecard): ClientTag {
  return sc.tier === "STRONG" ? "strong" : sc.tier === "POSSIBLE" ? "possible" : "stretch";
}

const plural = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;

export function clientReason(sc: Scorecard): string {
  const parts: string[] = [];

  const y = sc.years;
  if (y.required != null && y.actual != null) {
    parts.push(
      y.met
        ? `${y.required}+ years required — has ${y.actual}.`
        : `${y.required}+ years required — has ${y.actual}.`
    );
  } else if (y.actual != null) {
    parts.push(`${y.actual} years of relevant experience.`);
  }

  const s = sc.stack;
  if (s.total > 0) {
    if (s.matched === s.total) parts.push(`Covers your full stack (${plural(s.total, "skill")}).`);
    else if (s.matched > 0) parts.push(`Covers ${s.matched} of your ${plural(s.total, "listed skill")}.`);
    else parts.push(`No overlap found with your listed stack.`);
  }

  if (sc.seniority.level === "staff+")
    parts.push("Shows staff-level scope: architecture and cross-team ownership.");
  else if (sc.seniority.level === "senior")
    parts.push("Shows senior-level ownership in past roles.");

  if (sc.gaps.length > 0) {
    parts.push(`Worth probing: ${sc.gaps.slice(0, 2).join("; ").toLowerCase()}.`);
  } else if (sc.tier === "STRONG") {
    parts.push("No gaps against your requirements.");
  }

  return parts.join(" ");
}
