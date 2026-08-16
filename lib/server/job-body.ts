// Shared validation for the dashboard create/edit-job routes: raw request
// body -> RoleInput (minus jobId, which create assigns and edit preserves).
// Enforces the publish-quality bar from lib/role-options — a role can't go
// live without a substantive about section and itemized responsibilities/
// requirements, because the screening engine reads exactly these fields.
import type { RoleInput } from "./roles-pipeline";
import type { SkillSpec } from "./publish-role";
import {
  ROLE_CITY_OPTIONS,
  WORKPLACE_OPTIONS,
  VISA_OPTIONS,
  MIN_ABOUT_CHARS,
  MIN_DOING,
  MIN_NEEDS,
} from "@/lib/role-options";

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const items = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => str(x, 300))
    .filter(Boolean)
    .slice(0, max);
const picks = (v: unknown, allowed: readonly string[]): string[] =>
  (Array.isArray(v) ? v.map(String) : []).filter((x) => allowed.includes(x));
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 40 ? Math.round(n) : null;
};

export function yoeText(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${min} - ${max} years`;
  if (min != null) return `${min}+ years`;
  if (max != null) return `Up to ${max} years`;
  return "";
}

export function roleInputFromBody(
  body: Record<string, unknown>,
  skills: SkillSpec[]
): { role: Omit<RoleInput, "jobId"> & { jobId: string } } | { error: string } {
  const title = str(body.title, 120);
  if (!title) return { error: "title_required" };

  const about = str(body.about, 4000);
  if (about.length < MIN_ABOUT_CHARS) return { error: "about_too_short" };
  const doing = items(body.doing, 15);
  if (doing.length < MIN_DOING) return { error: "not_enough_responsibilities" };
  const needs = items(body.needs, 15);
  if (needs.length < MIN_NEEDS) return { error: "not_enough_requirements" };

  const yoeMin = num(body.yoeMin);
  const yoeMax = num(body.yoeMax);
  if (yoeMin != null && yoeMax != null && yoeMax < yoeMin)
    return { error: "yoe_max_below_min" };

  const workplace = picks(body.workplace, WORKPLACE_OPTIONS);
  const locations = picks(body.locations, ROLE_CITY_OPTIONS);
  const visa = picks(body.visa, VISA_OPTIONS);

  return {
    role: {
      jobId: "",
      title,
      roleType: str(body.roleType, 60),
      salary: str(body.salary, 60),
      yoe: yoeText(yoeMin, yoeMax),
      visa: visa.join("; "),
      workplace: workplace.join(" / "),
      locations,
      techStack: skills.map((s) => s.skill).join(", "),
      description: null,
      jd: {
        about,
        doing,
        needs,
        bonus: items(body.bonus, 8),
      },
    },
  };
}
