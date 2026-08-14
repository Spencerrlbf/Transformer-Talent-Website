import rolesSnapshot from "@/data/roles.json";

export interface Role {
  jobId: string;
  title: string;
  description: string;
  salary: string;
  locations: string[];
  techStack: string;
  industry: string;
  workplace: string;
  roleType: string;
  equity: string;
  funding: string;
  teamSize: string;
  visa: string;
  yoe: string;
}

const NOTION_VERSION = "2022-06-28";

// Roles come live from the Notion jobs table when NOTION_TOKEN and
// NOTION_DATABASE_ID are configured (revalidated hourly); otherwise from the
// committed snapshot in data/roles.json (refreshed at import time).
export async function getRoles(): Promise<Role[]> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (token && dbId) {
    try {
      return await fetchNotionRoles(token, dbId);
    } catch (err) {
      console.error("notion roles fetch failed; using snapshot", err);
    }
  }
  return rolesSnapshot as Role[];
}

interface NotionPage {
  properties: Record<
    string,
    {
      type: string;
      title?: { plain_text: string }[];
      rich_text?: { plain_text: string }[];
      multi_select?: { name: string }[];
    }
  >;
}

function text(p?: NotionPage["properties"][string]): string {
  const parts = p?.title ?? p?.rich_text ?? [];
  return parts.map((t) => t.plain_text).join("").trim();
}

async function fetchNotionRoles(token: string, dbId: string): Promise<Role[]> {
  const roles: Role[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`notion query ${res.status}`);
    const data = await res.json();
    for (const page of data.results as NotionPage[]) {
      const p = page.properties;
      roles.push({
        jobId: text(p["JobID"]),
        title: text(p["Job Title"]),
        description: text(p["Description"]),
        salary: text(p["Salary (Base)"]),
        locations: (p["Locations"]?.multi_select ?? []).map((o) => o.name),
        techStack: text(p["Tech Stack"]),
        industry: text(p["Industry"]),
        workplace: text(p["Workplace"]),
        roleType: text(p["Role Type"]),
        equity: text(p["Equity"]),
        funding: text(p["Funding"]),
        teamSize: text(p["Team Size"]),
        visa: text(p["Visa"]),
        yoe: text(p["YOE"]),
      });
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  roles.sort((a, b) => a.title.localeCompare(b.title) || a.jobId.localeCompare(b.jobId));
  return roles.filter((r) => r.title);
}

export function parseSalary(s: string): { min: number; max: number } | null {
  const nums = s.toLowerCase().match(/\$?\s*(\d+(?:\.\d+)?)k/g);
  if (!nums || nums.length < 2) return null;
  const vals = nums.map((n) => parseFloat(n.replace(/[^0-9.]/g, "")) * 1000);
  return { min: Math.min(...vals), max: Math.max(...vals) };
}
