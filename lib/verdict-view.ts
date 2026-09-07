// The verdict as the product shows it: an action label, one paragraph, and a
// technologies strip. Shared by server (writes it) and client (renders it).
// Stored as jsonb with v: 2 so older rows keep rendering the old way.

export type VerdictLabel = "contact" | "message" | "pass";

export const VERDICT_LABEL: Record<VerdictLabel, string> = {
  contact: "Contact now",
  message: "Worth a message",
  pass: "Pass",
};

/** dash-tag class per label. */
export const VERDICT_CLASS: Record<VerdictLabel, string> = {
  contact: "t-contact",
  message: "t-message",
  pass: "t-pass",
};

export type ChipStatus = "met" | "equivalent" | "plain" | "gap";

export interface TechChip {
  name: string;
  /** Dated career years with this technology, when the positions say. */
  years: number | null;
  status: ChipStatus;
  /** What decided the status, for the tooltip ("pgvector", "Ruby, 6y at Stripe"). */
  evidence?: string;
}

export interface RequirementRead {
  requirement: string;
  status: "met" | "equivalent" | "missing";
  evidence: string;
}

export interface VerdictView {
  v: 2;
  label: VerdictLabel;
  paragraph: string;
  missing: string[];
  ask: string[];
  betterSuited: string;
  requirements: RequirementRead[];
  tech: {
    now: TechChip[];
    before: TechChip[];
    /** Requirements with no evidence on the profile or resume. */
    gaps: string[];
    nowPosition?: string | null;
  };
  model: string;
  at: string;
}

export const isVerdictView = (x: unknown): x is VerdictView =>
  !!x && typeof x === "object" && (x as { v?: unknown }).v === 2 && typeof (x as { paragraph?: unknown }).paragraph === "string";

/** The first N sentences of the paragraph, for a table row. */
export function firstSentences(text: string, n = 2): string {
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
  return parts.slice(0, n).join("").trim();
}

/** Up to `max` chips for a row: matches first, then equivalents, then the first gap. */
export function rowChips(view: VerdictView, max = 5): TechChip[] {
  const all = [...view.tech.now, ...view.tech.before];
  const seen = new Set<string>();
  const uniq = all.filter((c) => {
    const k = c.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const met = uniq.filter((c) => c.status === "met");
  const eq = uniq.filter((c) => c.status === "equivalent");
  const out: TechChip[] = [...met, ...eq].slice(0, max - (view.tech.gaps.length ? 1 : 0));
  if (view.tech.gaps.length) out.push({ name: view.tech.gaps[0], years: null, status: "gap", evidence: "Required by the role; no evidence on the profile or resume" });
  return out.slice(0, max);
}
