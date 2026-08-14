import rolesData from "@/data/roles.json";

export interface Role {
  slug: string;
  title: string;
  location: string;
  salary: string;
  salaryMin: number;
  salaryMax: number;
  tags: string[];
  description: string;
  active: boolean;
}

// Single source of truth for open roles. Currently backed by data/roles.json;
// swap this implementation for the Notion API without touching any page.
export async function getRoles(): Promise<Role[]> {
  return (rolesData as Role[]).filter((r) => r.active);
}

export async function getRole(slug: string): Promise<Role | undefined> {
  const roles = await getRoles();
  return roles.find((r) => r.slug === slug);
}
