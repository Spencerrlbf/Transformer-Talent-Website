// Paste-a-JD prefill for the dashboard create-job form: one LLM extraction
// call that maps free JD text into our structured fields, including skills
// with suggested must-have flags and acceptable alternates. The employer
// reviews and corrects before publishing — this is a drafting aid, never a
// silent authority.

export type ExtractedSkill = { skill: string; must_have: boolean; alternates: string[] };

export type ExtractedJd = {
  title: string;
  role_type: string;
  salary: string;
  yoe: string;
  visa: string;
  workplace: "Remote" | "Hybrid" | "On-site" | "";
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
    yoe: { type: "string" },
    visa: { type: "string" },
    workplace: { type: "string", enum: ["Remote", "Hybrid", "On-site", ""] },
    locations: { type: "array", items: { type: "string" } },
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
    "title", "role_type", "salary", "yoe", "visa", "workplace", "locations",
    "about", "doing", "needs", "bonus", "skills",
  ],
} as const;

const SYSTEM =
  "Extract structured job fields from this job description, faithfully — never invent facts that aren't stated. " +
  "title: the job title. role_type: a short category like 'Backend', 'Full-Stack', 'ML/AI', 'DevOps/Infra', 'Product', 'Data'. " +
  "salary: the stated range verbatim (e.g. '$150K - $200K'), empty if absent. " +
  "yoe: years-of-experience requirement as stated (e.g. '3 - 6 years', '5+ years'), empty if absent. " +
  "visa: any visa/sponsorship statement, empty if absent. " +
  "workplace: Remote, Hybrid, or On-site if determinable, else empty. locations: city names mentioned as work locations. " +
  "about: 2-3 sentences summarizing the company and role WITHOUT naming the company. " +
  "doing: main responsibilities, one item each. needs: hard requirements, one item each. bonus: nice-to-have items. " +
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
