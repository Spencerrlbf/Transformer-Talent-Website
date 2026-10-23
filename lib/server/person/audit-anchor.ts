// Server/worker only. Freeze the exact already-verified legacy document; this
// helper never admits new facts or calls the normalized writer.
import { fromLegacyImport } from './fromLegacy';
import { PARSER_VERSION, stableStringify } from './normalize';
import type { PersonDoc } from './types';

export function prepareLegacyAuditAnchor(snapshot: Record<string, any>): {
  candidate_id: string; status: 'ready' | 'review' | 'anchored'; reason?: string;
  doc?: PersonDoc; proof?: string; canonical?: string;
} {
  const id = snapshot.candidate_id;
  if (snapshot.status === 'anchored') return { candidate_id: id, status: 'anchored' };
  if (snapshot.status !== 'ready')
    return { candidate_id: id, status: 'review', reason: snapshot.reason ?? 'historical_verification_required' };
  if (snapshot.row?.id !== id || !/^[a-f0-9]{32}$/.test(snapshot.proof ?? ''))
    throw Error('audit_snapshot_identity');
  const doc = fromLegacyImport(snapshot.row, snapshot.legacy, snapshot.v2, snapshot.comms);
  const source = doc.source;
  const exact = (snapshot.source_catalog ?? []).some((s: any) =>
    s.candidate_id === id && s.source === 'legacy_import' && s.source_ref === id &&
    s.payload_hash === source.payload_hash && s.parser_version === PARSER_VERSION &&
    Date.parse(s.fetched_at) === Date.parse(source.fetched_at) &&
    s.provider === source.provider && s.raw_in === source.raw_in &&
    s.enrichment_id === source.enrichment_id);
  if (!exact) return { candidate_id: id, status: 'review', reason: 'legacy_source_mismatch' };
  const { source: _, ...content } = doc;
  const canonical = stableStringify({ content, source: source.source, ref: source.source_ref,
    at: source.fetched_at, v: PARSER_VERSION });
  return { candidate_id: id, status: 'ready', doc, proof: snapshot.proof, canonical };
}
