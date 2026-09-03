// Home goals + attention: the small amount of state the cards own. Weekly
// targets (org default + per-seat override), the owner's attention rules,
// and per-seat snoozes on attention rows. Everything counted on the cards
// comes from tables the app already writes (see home-metrics.ts).
import { sbRest } from "./supabase";
import { DEFAULT_RULES, DEFAULT_TARGETS, sanitizeRules, sanitizeTargets, type AttentionRules, type Targets } from "@/lib/goals";

type TargetRow = { member_email: string; emails: number; calls: number; interviewing: number; placements: number };
const COLS = "member_email,emails,calls,interviewing,placements";
const shape = (r: TargetRow): Targets => ({ emails: r.emails, calls: r.calls, interviewing: r.interviewing, placements: r.placements });

/** The org default plus every seat's own row. */
export async function loadTargets(orgId: string): Promise<{ defaults: Targets; bySeat: Map<string, Targets> }> {
  const res = await sbRest(`goal_targets?organization_id=eq.${orgId}&select=${COLS}&limit=500`);
  const rows = res.ok ? ((await res.json()) as TargetRow[]) : [];
  const bySeat = new Map<string, Targets>();
  let defaults = DEFAULT_TARGETS;
  for (const r of rows) {
    if (r.member_email === "") defaults = shape(r);
    else bySeat.set(r.member_email, shape(r));
  }
  return { defaults, bySeat };
}

/** memberEmail '' = the org default (owner only; the route enforces it). */
export async function saveTargets(orgId: string, memberEmail: string, values: unknown): Promise<Targets | null> {
  const t = sanitizeTargets(values);
  const res = await sbRest(`goal_targets?on_conflict=organization_id,member_email`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ organization_id: orgId, member_email: memberEmail, ...t, updated_at: new Date().toISOString() }),
  });
  return res.ok ? t : null;
}

/** Drop a seat's own row so the org default applies again. */
export async function clearTargets(orgId: string, memberEmail: string): Promise<boolean> {
  if (!memberEmail) return false;
  const res = await sbRest(`goal_targets?organization_id=eq.${orgId}&member_email=eq.${encodeURIComponent(memberEmail)}`, { method: "DELETE" });
  return res.ok;
}

export async function loadAttentionRules(orgId: string): Promise<AttentionRules> {
  const res = await sbRest(`organizations?id=eq.${orgId}&select=attention_rules&limit=1`);
  const [row] = res.ok ? ((await res.json()) as { attention_rules: unknown }[]) : [];
  return row?.attention_rules ? sanitizeRules(row.attention_rules) : DEFAULT_RULES;
}

export async function saveAttentionRules(orgId: string, values: unknown): Promise<AttentionRules | null> {
  const rules = sanitizeRules(values);
  const res = await sbRest(`organizations?id=eq.${orgId}`, {
    method: "PATCH",
    body: JSON.stringify({ attention_rules: rules }),
    prefer: "return=minimal",
  });
  return res.ok ? rules : null;
}

// Row keys: reply:<key> | contacted:<key>:<job> | interviewing:<key>:<job> |
// offer:<key>:<job> | role:<job> | fdue:<key>
export const SNOOZE_KEY_RE = /^(reply|contacted|interviewing|offer|role|fdue):[A-Za-z0-9_:.-]{1,160}$/;

/** This seat's live snoozes (until >= today). */
export async function loadSnoozes(orgId: string, memberEmail: string, today: string): Promise<Set<string>> {
  const res = await sbRest(
    `attention_snoozes?organization_id=eq.${orgId}&member_email=eq.${encodeURIComponent(memberEmail)}&until=gte.${today}&select=item_key&limit=1000`
  );
  const rows = res.ok ? ((await res.json()) as { item_key: string }[]) : [];
  return new Set(rows.map((r) => r.item_key));
}

export async function snoozeAttention(orgId: string, memberEmail: string, key: string, until: string): Promise<boolean> {
  if (!SNOOZE_KEY_RE.test(key) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return false;
  const res = await sbRest(`attention_snoozes?on_conflict=organization_id,member_email,item_key`, {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: JSON.stringify({ organization_id: orgId, member_email: memberEmail, item_key: key, until }),
  });
  return res.ok;
}
