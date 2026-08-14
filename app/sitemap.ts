import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://transformertalent.com";
  return [
    { url: base, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/roles`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/talent`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${base}/placements`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/process`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/market-index`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/apply`, changeFrequency: "monthly", priority: 0.7 },
  ];
}
