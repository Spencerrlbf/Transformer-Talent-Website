#!/usr/bin/env node
// Generate structured matching profiles for every live role from the
// (already anonymized) rewritten JD + structured fields. Re-run when roles change.
import fs from "node:fs";
const roles = JSON.parse(fs.readFileSync(new URL("../data/roles.json", import.meta.url)));
const KEY = process.env.OPENAI_API_KEY;

const schema = {
  type: "object", additionalProperties: false,
  properties: {
    must_haves: { type: "array", items: { type: "string" } },
    nice_to_haves: { type: "array", items: { type: "string" } },
    screening_questions: { type: "array", items: { type: "string" } },
    min_years: { type: ["integer", "null"] },
    visa_transfer_ok: { type: "boolean" },
    onsite_city: { type: ["string", "null"] },
  },
  required: ["must_haves", "nice_to_haves", "screening_questions", "min_years", "visa_transfer_ok", "onsite_city"],
};

async function profileFor(r) {
  const source = [
    `TITLE: ${r.title}`, `ROLE TYPE: ${r.roleType}`, `YOE: ${r.yoe}`, `VISA: ${r.visa}`,
    `WORKPLACE: ${r.workplace}`, `LOCATIONS: ${r.locations.join(", ")}`, `STACK: ${r.techStack}`,
    r.jd ? `ABOUT: ${r.jd.about}\nDOING: ${(r.jd.doing || []).join("; ")}\nNEEDS: ${(r.jd.needs || []).join("; ")}\nBONUS: ${(r.jd.bonus || []).join("; ")}` : `DESC: ${r.description}`,
  ].join("\n");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini", temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "matching_profile", strict: true, schema } },
      messages: [
        { role: "system", content:
          "Build a candidate-screening profile for this role. must_haves: 3-6 hard requirements a recruiter would reject on (concise). " +
          "nice_to_haves: max 4. screening_questions: 4-6 yes/no-answerable questions testing the must-haves against a candidate's history. " +
          "min_years: minimum years of experience implied (null if genuinely open). " +
          "visa_transfer_ok: true only if VISA field mentions transfers/sponsorship. " +
          "onsite_city: the required city if strictly on-site in one city, else null." },
        { role: "user", content: source },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${r.jobId}: ${res.status} ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

const out = {};
let done = 0;
const queue = [...roles];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const r = queue.shift();
    try {
      out[r.jobId] = await profileFor(r);
    } catch (e) {
      console.error("fail", r.jobId, String(e).slice(0, 120));
    }
    done++;
    if (done % 20 === 0) console.log(done, "/", roles.length);
  }
}));
fs.writeFileSync(new URL("../data/matching-profiles.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`wrote ${Object.keys(out).length} matching profiles`);
