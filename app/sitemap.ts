import type { MetadataRoute } from "next";
import { getRoles, roleSlug } from "@/lib/roles";
import { FAMILY_PAGES } from "@/lib/market";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = "https://transformertalent.com";
  const roles = await getRoles();
  return [
    { url: base, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/roles`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/talent`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/placements`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/process`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/market-index`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/apply`, changeFrequency: "monthly", priority: 0.7 },
    ...FAMILY_PAGES.map((f) => ({
      url: `${base}/market-index/${f.slug}`,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...roles.map((r) => ({
      url: `${base}/roles/${roleSlug(r)}`,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
