"use client";
// The skills on the report card as chips in three rows: on the current job,
// on previous jobs (each with the year it was last used), and listed on the
// profile but never tagged on a job. Written by code from the job tags and
// dates; skillsByRecency does the grouping.
import type { ProfileFacts } from "@/lib/rolecard";
import { yearsTiny } from "./report-format";
import { skillsByRecency, type SkillChip } from "./skills-recency";

type Kind = "now" | "before" | "listed";

function Chip({ c, kind }: { c: SkillChip; kind: Kind }) {
  const title = c.where.length ? `Tagged on ${c.where.join(", ")}` : kind === "listed" ? "On the profile's skills list, never tagged on a job" : undefined;
  return (
    <span className={`vc-skchip ${kind}`} title={title}>
      {c.name}
      {kind !== "listed" && <small>{c.years != null && c.years > 0 ? yearsTiny(c.years) : c.internOnly ? "internship only" : "undated"}</small>}
      {kind === "before" && c.lastUsed && <small>· to {c.lastUsed}</small>}
    </span>
  );
}

function Group({ kind, chips, label, note }: { kind: Kind; chips: SkillChip[]; label: string; note: string }) {
  if (!chips.length) return null;
  return (
    <div className="vc-skgroup">
      <div className="vc-skg-h">
        <b>{label}</b>
        {note && <small>{note}</small>}
      </div>
      <div className="vc-skchips">
        {chips.map((c, i) => (
          <Chip key={`${c.name}-${i}`} c={c} kind={kind} />
        ))}
      </div>
    </div>
  );
}

export default function SkillsChips({ p }: { p: ProfileFacts }) {
  const g = skillsByRecency(p);
  if (!g.current.length && !g.previous.length && !g.listed.length) return <p className="vc-none">No skills tagged on the profile&apos;s jobs.</p>;
  return (
    <div className="vc-skgroups">
      <Group kind="now" chips={g.current} label="Current job" note={g.currentNote} />
      <Group kind="before" chips={g.previous} label="Previous jobs" note="with the year last used" />
      <Group kind="listed" chips={g.listed} label="Listed only" note="never tagged on a job" />
    </div>
  );
}
