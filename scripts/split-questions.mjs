#!/usr/bin/env node
// One-time pass over data/matching-profiles.json: split compound screening
// questions (two+ distinct facts joined by "and") into single-fact questions,
// so every yes/no/unclear answer is individually honest. "Or"-alternatives
// (either satisfies) and single-concept ranges stay whole. Max 8 questions
// per role (the screener's per-role cap) — earlier questions carry priority.
// After running: node scripts/sync-org-roles.mjs (role_hash changes -> cached
// verdicts go stale automatically), then PRECOMPUTE_BACKFILL to re-screen.
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const OPENAI = process.env.OPENAI_API_KEY;
if (!OPENAI) throw new Error("OPENAI_API_KEY required");

const path = new URL("../data/matching-profiles.json", import.meta.url);
const profiles = JSON.parse(fs.readFileSync(path, "utf8"));
const jobIds = Object.keys(profiles);

async function splitBatch(batch) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "splits",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["roles"],
            properties: {
              roles: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["job_id", "questions"],
                  properties: {
                    job_id: { type: "string" },
                    questions: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "You refine screening-question lists so each question tests exactly ONE fact. " +
            "SPLIT a question only when it requires multiple DISTINCT facts to all hold — " +
            "typically 'and' joining different skills/tools ('Python and FastAPI?' -> " +
            "'Are you proficient in Python?' + 'Have you used FastAPI?'). " +
            "DO NOT split: 'or'-alternatives where either satisfies ('ML or AI engineering'), " +
            "single concepts with ranges ('5-8 years'), or natural pairings that form one " +
            "capability ('LLMs and embeddings' stays if it describes one area of work; split " +
            "if they are separately checkable tools). Keep original wording and order where " +
            "unchanged; splits replace the original in place. Short, yes/no-answerable questions.",
        },
        {
          role: "user",
          content: batch
            .map((id) => `ROLE ${id}:\n${profiles[id].screening_questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`)
            .join("\n\n"),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}: ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content).roles;
}

let changed = 0, totalBefore = 0, totalAfter = 0;
for (let i = 0; i < jobIds.length; i += 12) {
  const batch = jobIds.slice(i, i + 12);
  const out = await splitBatch(batch);
  for (const r of out) {
    const id = String(r.job_id).replace(/^role\s*/i, "").trim();
    if (!profiles[id] || !r.questions?.length) continue;
    const before = profiles[id].screening_questions;
    const after = r.questions.map((q) => q.trim()).filter(Boolean).slice(0, 8);
    totalBefore += before.length;
    totalAfter += after.length;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      profiles[id].screening_questions = after;
      changed++;
    }
  }
  console.log(`processed ${Math.min(i + 12, jobIds.length)}/${jobIds.length}`);
}

fs.writeFileSync(path, JSON.stringify(profiles, null, 2) + "\n");
console.log(`done: ${changed} roles changed, questions ${totalBefore} -> ${totalAfter}`);
