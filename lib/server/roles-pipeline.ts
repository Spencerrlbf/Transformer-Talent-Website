// Single-source role pipeline: matching-profile generation (LLM), embedding
// text builders, and org_roles row shaping. The roles scripts (via the worker
// bundle) and the dashboard create/edit-job flow both call these, so every
// path produces byte-identical artifacts. Text builders are pure — changing
// them changes role content hashes, which re-embeds roles and can invalidate
// verdict-cache role hashes, so treat any edit here as a screening change.

export type RoleJd = {
  about?: string;
  doing?: string[];
  needs?: string[];
  bonus?: string[];
};

export type RoleInput = {
  jobId: string;
  title: string;
  description?: string | null;
  jd?: RoleJd | null;
  roleType?: string;
  yoe?: string;
  visa?: string;
  workplace?: string;
  locations?: string[];
  techStack?: string;
  industry?: string;
  salary?: string;
  company?: ({ blurb?: string } & Record<string, unknown>) | null;
};

export type MatchingProfile = {
  must_haves: string[];
  nice_to_haves: string[];
  screening_questions: string[];
  min_years: number | null;
  visa_transfer_ok: boolean;
  onsite_city: string | null;
};

export const MATCHING_PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    must_haves: { type: "array", items: { type: "string" } },
    nice_to_haves: { type: "array", items: { type: "string" } },
    screening_questions: { type: "array", items: { type: "string" } },
    min_years: { type: ["integer", "null"] },
    visa_transfer_ok: { type: "boolean" },
    onsite_city: { type: ["string", "null"] },
  },
  required: [
    "must_haves",
    "nice_to_haves",
    "screening_questions",
    "min_years",
    "visa_transfer_ok",
    "onsite_city",
  ],
} as const;

export const MATCHING_PROFILE_SYSTEM =
  "Build a candidate-screening profile for this role. must_haves: 3-6 hard requirements a recruiter would reject on (concise). " +
  "nice_to_haves: max 4. screening_questions: 4-8 yes/no-answerable questions testing the must-haves against a candidate's history. " +
  "Each question must test exactly ONE fact — never join two distinct skills/tools with 'and' " +
  "('Python and FastAPI?' must be two questions); 'or'-alternatives where either satisfies may stay as one. " +
  "min_years: minimum years of experience implied (null if genuinely open). " +
  "visa_transfer_ok: true only if VISA field mentions transfers/sponsorship. " +
  "onsite_city: the required city if strictly on-site in one city, else null.";

export function matchingProfileSource(r: RoleInput): string {
  return [
    `TITLE: ${r.title}`,
    `ROLE TYPE: ${r.roleType}`,
    `YOE: ${r.yoe}`,
    `VISA: ${r.visa}`,
    `WORKPLACE: ${r.workplace}`,
    `LOCATIONS: ${(r.locations || []).join(", ")}`,
    `STACK: ${r.techStack}`,
    r.jd
      ? `ABOUT: ${r.jd.about}\nDOING: ${(r.jd.doing || []).join("; ")}\nNEEDS: ${(r.jd.needs || []).join("; ")}\nBONUS: ${(r.jd.bonus || []).join("; ")}`
      : `DESC: ${r.description}`,
  ].join("\n");
}

export function matchingProfileRequestBody(r: RoleInput): Record<string, unknown> {
  return {
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: "matching_profile", strict: true, schema: MATCHING_PROFILE_SCHEMA },
    },
    messages: [
      { role: "system", content: MATCHING_PROFILE_SYSTEM },
      { role: "user", content: matchingProfileSource(r) },
    ],
  };
}

export async function generateMatchingProfile(r: RoleInput): Promise<MatchingProfile> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(matchingProfileRequestBody(r)),
  });
  if (!res.ok) throw new Error(`${r.jobId}: ${res.status} ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

// Text embedded into site_role_embeddings (legacy site matcher).
export function siteEmbeddingText(r: RoleInput): string {
  return [
    r.title,
    r.roleType,
    r.description,
    r.jd?.about,
    (r.jd?.needs || []).join(". "),
    r.techStack,
    r.industry,
    (r.locations || []).join(", "),
  ]
    .filter(Boolean)
    .join(". ")
    .slice(0, 7000);
}

// Faceted texts embedded into job_embeddings (V2 spine).
export function facetTexts(
  r: RoleInput,
  profile: MatchingProfile | null | undefined
): { context: string; requirements: string } {
  return {
    context: [
      r.title,
      r.roleType,
      r.description,
      r.jd?.about,
      r.company?.blurb,
      r.industry,
      r.locations?.join(", "),
      r.workplace,
    ]
      .filter(Boolean)
      .join(". ")
      .slice(0, 7000),
    requirements: [
      (r.jd?.needs || []).join(". "),
      r.techStack,
      (profile?.must_haves || []).join(". "),
      r.yoe,
    ]
      .filter(Boolean)
      .join(". ")
      .slice(0, 7000),
  };
}

// org_roles upsert row. Callers add status/source/updated_at variations.
export function orgRoleRow(
  organizationId: string,
  r: RoleInput,
  profile: MatchingProfile | null | undefined,
  source: string
): Record<string, unknown> {
  return {
    organization_id: organizationId,
    external_id: r.jobId,
    title: r.title,
    description: r.description || null,
    jd: r.jd || null,
    matching_profile: profile || null,
    salary: r.salary || null,
    locations: r.locations || [],
    workplace: r.workplace || null,
    visa: r.visa || null,
    yoe: r.yoe || null,
    role_type: r.roleType || null,
    tech_stack: r.techStack || null,
    industry: r.industry || null,
    company_profile: r.company || null,
    status: "open",
    source,
    updated_at: new Date().toISOString(),
  };
}

export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIMS = 1536;

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed ${res.status}: ${await res.text()}`);
  const data = (await res.json()).data as { embedding: number[] }[];
  return data.map((d) => d.embedding);
}
