// Paste-or-upload-a-JD prefill for the dashboard create-job form: one LLM
// extraction call that maps free JD text into our structured fields —
// numeric years, multi-select visa/workplace/locations from the canonical
// lists, itemized responsibilities/requirements, and skills with suggested
// must-have flags and acceptable alternates. The employer reviews and
// corrects before publishing — this is a drafting aid, never a silent
// authority. Fields the JD doesn't state come back empty and are surfaced
// as warnings, not invented.
import { ROLE_CITY_OPTIONS, WORKPLACE_OPTIONS, VISA_OPTIONS } from "@/lib/role-options";

export type ExtractedSkill = { skill: string; must_have: boolean; alternates: string[] };

export type ExtractedJd = {
  title: string;
  role_type: string;
  salary: string;
  yoe_min: number | null;
  yoe_max: number | null;
  visa_options: string[];
  workplace: string[];
  locations: string[];
  about: string;
  doing: string[];
  needs: string[];
  bonus: string[];
  skills: ExtractedSkill[];
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    role_type: { type: "string" },
    salary: { type: "string" },
    yoe_min: { type: ["integer", "null"] },
    yoe_max: { type: ["integer", "null"] },
    visa_options: { type: "array", items: { type: "string", enum: [...VISA_OPTIONS] } },
    workplace: { type: "array", items: { type: "string", enum: [...WORKPLACE_OPTIONS] } },
    locations: { type: "array", items: { type: "string", enum: [...ROLE_CITY_OPTIONS] } },
    about: { type: "string" },
    doing: { type: "array", items: { type: "string" } },
    needs: { type: "array", items: { type: "string" } },
    bonus: { type: "array", items: { type: "string" } },
    skills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          skill: { type: "string" },
          must_have: { type: "boolean" },
          alternates: { type: "array", items: { type: "string" } },
        },
        required: ["skill", "must_have", "alternates"],
      },
    },
  },
  required: [
    "title", "role_type", "salary", "yoe_min", "yoe_max", "visa_options",
    "workplace", "locations", "about", "doing", "needs", "bonus", "skills",
  ],
} as const;

const SYSTEM =
  "Extract structured job fields from this job description, faithfully — never invent facts that aren't stated; leave fields empty/null when the JD is silent. " +
  "title: the job title. role_type: a short category like 'Backend', 'Full-Stack', 'ML/AI', 'DevOps/Infra', 'Product', 'Data'. " +
  "salary: the stated range verbatim (e.g. '$150K - $200K'), empty if absent. " +
  "yoe_min/yoe_max: years-of-experience bounds as integers ('3-6 years' -> 3 and 6; '5+ years' -> 5 and null); both null if not stated. " +
  "visa_options: which of the allowed statements the JD actually makes (empty if it says nothing about visas). " +
  "workplace: all arrangements the JD allows. locations: work cities mapped onto the allowed list (map metro areas to their city, e.g. Bay Area/South Bay -> San Francisco; Brooklyn -> New York); omit cities not on the list. " +
  "about: 3-6 sentences summarizing the company, the mission, and what this role owns, WITHOUT naming the company. " +
  "doing: main responsibilities, one item each (aim for every distinct responsibility in the JD). " +
  "needs: hard requirements, one item each. bonus: nice-to-have items. " +
  "skills: 4-10 concrete technologies/tools from the JD. must_have=true only when the JD treats it as required rather than preferred. " +
  "alternates: up to 3 equivalent technologies a reasonable employer would accept instead (e.g. Python -> Golang, Rust; AWS -> GCP, Azure); empty array if none make sense. " +
  "Keep every extracted string concise.";

export async function extractJd(text: string): Promise<ExtractedJd> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "jd_extract", strict: true, schema: SCHEMA },
      },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: text.slice(0, 24000) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`jd extract ${res.status}: ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

// What the extraction couldn't find — shown to the employer as warnings.
export function extractionWarnings(e: ExtractedJd): string[] {
  const w: string[] = [];
  if (e.visa_options.length === 0)
    w.push("No visa policy found in the JD — set it below or leave it blank.");
  if (!e.salary) w.push("No salary range found in the JD.");
  if (e.yoe_min == null && e.yoe_max == null)
    w.push("No years-of-experience requirement found in the JD.");
  if (e.locations.length === 0 && !e.workplace.includes("Remote"))
    w.push("No work location found in the JD (or the city isn't on our standard list).");
  return w;
}
