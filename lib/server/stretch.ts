// Stretch channel (internal experiment): retrieval by INFERRED capability.
// Signal phrases from cached verdicts become search queries against the role
// base — embedding side hits the requirements-facet vectors, keyword side
// hits stack/title/must-haves. Only pairings the evidence channels did NOT
// find count; hard cap keeps speculation honest. Resulting verdicts are
// stored with source='stretch' + the spawning signal, and NOTHING user-facing
// reads them — review via mark-outcome, promote only if outcomes earn it.
// Delete this module and the feature is gone; nothing else depends on it.

import { sbRpc } from "./supabase";
import { embed } from "./matcher";
import type { InferredSignal } from "./screening";

export interface StretchRole {
  jobId: string;
  title: string;
  fromSignal: string; // the signal text that surfaced this role
}

const STOPWORDS = new Set([
  "with", "and", "the", "for", "experience", "likely", "possible", "exposure",
  "using", "work", "worked", "working", "strong", "into", "from", "their",
]);

function signalTerms(signal: InferredSignal): string[] {
  return [...new Set(
    `${signal.signal}`
      .split(/[^A-Za-z0-9+#.-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()))
  )].slice(0, 8);
}

export async function findStretchRoles(
  signals: InferredSignal[],
  excludeJobIds: string[],
  cap = 2,
  // Tenant scoping: null = legacy all-orgs behavior. Pass the org id so
  // speculative pairings never cross tenants (external ids collide).
  organizationId: string | null = null
): Promise<StretchRole[]> {
  const exclude = new Set(excludeJobIds);
  const found = new Map<string, StretchRole>();

  for (const signal of signals.slice(0, 3)) {
    if (found.size >= cap * 3) break; // enough raw candidates to rank from
    const [vec, kw] = await Promise.all([
      embed(signal.signal)
        .then((v) =>
          sbRpc<{ external_id: string; title: string; similarity: number }[]>("match_org_roles", {
            query_embedding: v,
            match_count: 3,
            org_filter: organizationId,
          })
        )
        .catch(() => []),
      (() => {
        const terms = signalTerms(signal);
        return terms.length
          ? sbRpc<{ job_id: string; title: string; keyword_hits: number }[]>("match_roles_keyword", {
              skills: terms,
              match_count: 3,
              org_filter: organizationId,
            }).catch(() => [])
          : Promise.resolve([]);
      })(),
    ]);
    for (const r of vec) {
      if (!exclude.has(r.external_id) && !found.has(r.external_id)) {
        found.set(r.external_id, { jobId: r.external_id, title: r.title, fromSignal: signal.signal });
      }
    }
    for (const r of kw) {
      if (r.keyword_hits >= 2 && !exclude.has(r.job_id) && !found.has(r.job_id)) {
        found.set(r.job_id, { jobId: r.job_id, title: r.title, fromSignal: signal.signal });
      }
    }
  }
  return [...found.values()].slice(0, cap);
}
