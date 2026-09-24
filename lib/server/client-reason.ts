// Client-facing presentation of a scorecard: a friendly tag and a
// plain-English reason a founder can read. Pure code over the scorecard's
// structured fields — no LLM, and none of the internal shorthand or evidence
// trail ever crosses this boundary.
import type { Scorecard } from "./scorecard";
import { stripExamples, type CardRow } from "@/lib/rolecard";
import type { VerdictView } from "@/lib/verdict-view";

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

/** What of Transformer Talent's verdict may travel with a person TT sends to
 *  a client: the numbers the tag and reason above are computed from, and
 *  nothing else. Never the internal reason, the evidence behind each answer,
 *  the stack items, the report card or a recruiter's check-off notes. Null
 *  when the verdict has nothing to show. */
export function clientSafeVerdict(v: unknown): { qualified: boolean; scorecard: Scorecard } | null {
  const sc = (v as { scorecard?: Partial<Scorecard> } | null)?.scorecard;
  if (!sc?.tier) return fromReportCard((v as { v2?: VerdictView } | null)?.v2);
  return {
    qualified: (v as { qualified?: unknown }).qualified === true,
    scorecard: {
      tier: sc.tier,
      reason: "",
      stack: { items: [], matched: Number(sc.stack?.matched) || 0, total: Number(sc.stack?.total) || 0 },
      years: { required: sc.years?.required ?? null, actual: sc.years?.actual ?? null, met: sc.years?.met ?? null },
      seniority: { level: sc.seniority?.level ?? "unknown", signals: [] },
      // clientReason names two at most; the rest stay with TT.
      gaps: (sc.gaps || []).slice(0, 2).map(String),
    },
  };
}

/** A verdict that is a report card only (the scorecard judge), in the same
 *  client-safe shape: the tier from its label, the stack count from its
 *  technology rows, the gaps from the names of its Required rows not met.
 *  Nothing of the paragraph, evidence, quotes or check-offs. */
function fromReportCard(view: VerdictView | null | undefined): { qualified: boolean; scorecard: Scorecard } | null {
  if (!view?.label) return null;
  const rows: CardRow[] = view.card?.rows || [];
  const met = (r: CardRow) => r.status === "yes" || r.status === "equivalent";
  const tech = rows.filter((r) => r.kind === "tech");
  const gaps = rows
    .filter((r) => r.tier === "required" && !met(r))
    .map((r) => stripExamples(r.label).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    qualified: view.label !== "pass",
    scorecard: {
      tier: view.label === "contact" ? "STRONG" : view.label === "message" ? "POSSIBLE" : "WEAK",
      reason: "",
      stack: { items: [], matched: tech.filter(met).length, total: tech.length },
      years: { required: null, actual: null, met: null },
      seniority: { level: "unknown", signals: [] },
      gaps: gaps.slice(0, 2),
    },
  };
}
