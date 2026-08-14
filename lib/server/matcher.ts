import { sbRpc } from "./supabase";

const OPENAI = "https://api.openai.com/v1";

function openaiKey() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY not configured");
  return k;
}

export interface ExtractedJD {
  title: string;
  seniority: string;
  min_years: number | null;
  max_years: number | null;
  locations: string[];
  remote_ok: boolean;
  skills: string[];
  embedding_summary: string;
}

// Mirrors the location expansion used by the local matching pipeline.
const LOCATION_EXPANSIONS: Record<string, string[]> = {
  "san francisco": ["San Francisco", "Bay Area", "Oakland", "Berkeley", "Palo Alto", "Mountain View", "Sunnyvale", "Santa Clara", "Redwood City", "Menlo Park", "San Jose", "Cupertino"],
  "bay area": ["San Francisco", "Bay Area", "Oakland", "Berkeley", "Palo Alto", "Mountain View", "San Jose"],
  "new york": ["New York", "NYC", "Manhattan", "Brooklyn", "Jersey City", "Hoboken"],
  "los angeles": ["Los Angeles", "Santa Monica", "Culver City", "Pasadena"],
  seattle: ["Seattle", "Bellevue", "Redmond", "Kirkland"],
  boston: ["Boston", "Cambridge", "Somerville"],
  austin: ["Austin", "Round Rock"],
  chicago: ["Chicago", "Evanston"],
  denver: ["Denver", "Boulder"],
  miami: ["Miami", "Fort Lauderdale"],
};

export function expandLocations(locations: string[]): string[] | null {
  const out = new Set<string>();
  for (const loc of locations) {
    const patterns = LOCATION_EXPANSIONS[loc.toLowerCase().trim()];
    if (patterns) patterns.forEach((p) => out.add(p));
    else if (loc.trim()) out.add(loc.trim());
  }
  return out.size ? [...out] : null;
}

export async function extractJD(jdText: string): Promise<ExtractedJD> {
  const res = await fetch(`${OPENAI}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "jd_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              seniority: { type: "string" },
              min_years: { type: ["integer", "null"] },
              max_years: { type: ["integer", "null"] },
              locations: { type: "array", items: { type: "string" } },
              remote_ok: { type: "boolean" },
              skills: { type: "array", items: { type: "string" } },
              embedding_summary: { type: "string" },
            },
            required: [
              "title", "seniority", "min_years", "max_years",
              "locations", "remote_ok", "skills", "embedding_summary",
            ],
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You extract structured data from job descriptions for a candidate-matching system. " +
            "embedding_summary must be a dense 2-4 sentence description of the ideal candidate " +
            "(role, seniority, core skills, domain) written like a candidate profile headline, " +
            "not a job ad. locations: city names only, empty array if remote/unspecified. " +
            "skills: max 12, most important first.",
        },
        { role: "user", content: jdText.slice(0, 24000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`extraction failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content) as ExtractedJD;
}

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OPENAI}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey()}`,
      "Content-Type": "application/json",
    },
    // Must match the model that produced candidates.matching_embedding.
    body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`embedding failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data[0].embedding as number[];
}

export interface MatchRow {
  id: string;
  current_title: string | null;
  current_company: string | null;
  location: string | null;
  years_experience: number | null;
  previous_companies: string[] | null;
  education_schools: string[] | null;
  education_degrees: string[] | null;
  education_fields: string[] | null;
  top_skills: string[] | null;
  headline: string | null;
  source: string | null;
  similarity: number;
}

export async function matchCandidates(
  embedding: number[],
  jd: ExtractedJD,
  count = 30
): Promise<MatchRow[]> {
  return sbRpc<MatchRow[]>("match_candidates_website", {
    query_embedding: embedding,
    match_count: count,
    min_years: jd.min_years && jd.min_years > 2 ? jd.min_years - 2 : null,
    max_years: null,
    location_patterns: jd.remote_ok ? null : expandLocations(jd.locations),
  });
}

function skillOverlap(jdSkills: string[], candidateSkills: string[] | null): number {
  if (!jdSkills.length || !candidateSkills?.length) return 0;
  const cand = candidateSkills.map((s) => s.toLowerCase());
  let hits = 0;
  for (const s of jdSkills) {
    const needle = s.toLowerCase();
    if (cand.some((c) => c.includes(needle) || needle.includes(c))) hits++;
  }
  return hits / jdSkills.length;
}

export interface AnonymizedMatch {
  ref: string;
  title: string;
  yearsExperience: number | null;
  location: string | null;
  previousCompanies: string[];
  education: string[];
  skills: string[];
  engaged: boolean;
  score: number;
}

// Composite scoring mirrors the local pipeline (embedding-major, keyword-minor);
// skills coverage is sparse in the pool so it's a boost, not a gate.
export function rankAndAnonymize(
  rows: MatchRow[],
  jd: ExtractedJD,
  top = 5
): AnonymizedMatch[] {
  const scored = rows
    .map((r) => ({
      row: r,
      score: 0.85 * r.similarity + 0.15 * skillOverlap(jd.skills, r.top_skills),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  return scored.map(({ row, score }, i) => {
    const current = (row.current_company || "").toLowerCase();
    // Previous employers shown; current employer never — title+company identifies.
    const prev = (row.previous_companies || [])
      .filter((c) => c && c.toLowerCase() !== current)
      .filter((c, idx, arr) => arr.indexOf(c) === idx)
      .slice(0, 3);
    const education = (row.education_schools || [])
      .map((school, idx) => {
        const degree = row.education_degrees?.[idx];
        return degree ? `${degree}, ${school}` : school;
      })
      .filter((e, idx, arr) => arr.indexOf(e) === idx)
      .slice(0, 2);
    return {
      ref: `TT-${String(i + 1).padStart(2, "0")}`,
      title: row.current_title || row.headline || "Software Engineer",
      yearsExperience: row.years_experience,
      location: row.location,
      previousCompanies: prev,
      education,
      skills: (row.top_skills || []).slice(0, 6),
      engaged: row.source === "airtable_sync",
      score: Math.round(score * 100) / 100,
    };
  });
}
