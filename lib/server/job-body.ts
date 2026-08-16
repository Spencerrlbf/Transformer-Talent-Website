// Shared validation for the dashboard create/edit-job routes: raw request
// body -> RoleInput (minus jobId, which create assigns and edit preserves).
import type { RoleInput } from "./roles-pipeline";
import type { SkillSpec } from "./publish-role";

const str = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const lines = (v: unknown, max: number): string[] => {
  if (Array.isArray(v)) return v.map((x) => str(x, 300)).filter(Boolean).slice(0, max);
  return String(v ?? "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, max);
};

export function roleInputFromBody(
  body: Record<string, unknown>,
  skills: SkillSpec[]
): { role: Omit<RoleInput, "jobId"> & { jobId: string } } | { error: string } {
  const title = str(body.title, 120);
  if (!title) return { error: "title_required" };
  const about = str(body.about, 2000);
  const needs = lines(body.needs, 12);
  if (!about && needs.length === 0) return { error: "about_or_needs_required" };

  const workplace = ["Remote", "Hybrid", "On-site"].includes(String(body.workplace))
    ? String(body.workplace)
    : "";

  return {
    role: {
      jobId: "",
      title,
      roleType: str(body.roleType, 60),
      salary: str(body.salary, 60),
      yoe: str(body.yoe, 40),
      visa: str(body.visa, 200),
      workplace,
      locations: lines(body.locations, 8).map((l) => l.slice(0, 60)),
      techStack: skills.map((s) => s.skill).join(", "),
      description: null,
      jd: {
        about,
        doing: lines(body.doing, 12),
        needs,
        bonus: lines(body.bonus, 8),
      },
    },
  };
}
