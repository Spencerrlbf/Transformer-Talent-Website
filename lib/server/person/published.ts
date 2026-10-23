// One MVCC snapshot, checked against the logical published revision. Never
// return an unpublished fallback for a person whose published state is stale.
import {
  PROFILE_FIELDS,
  projectionProfileHash,
  type PersonConnection,
} from "./save";
export async function publishedPersonRowsOnConnection(
  c: PersonConnection,
  ids: string[],
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (ids.length > 1000) throw Error("person_profile_read_limit");
  for (let offset = 0; offset < ids.length; offset += 100) {
    const rows = (
      await c.query(
        `select c.id,c.linkedin_url,c.linkedin_username,c.created_at,c.source,c.contact,
   c.calculated_experience_years,c.total_experience_years,c.linkedin_enrichment_date,
   ${PROFILE_FIELDS.map((k) => `c.${k}`).join(",")},p.revision published_revision,p.profile_hash,s.rev normalized_revision,
   exists(select 1 from public.person_source_holds h where h.candidate_id=c.id and h.resolved_at is null) held,
   coalesce((select jsonb_agg(jsonb_build_object('kind',cc.kind,'value_normalized',cc.value_normalized,'rank',cc.rank,'status',cc.status,'never_primary',cc.never_primary,'quality',cc.quality,'result',cc.result) order by cc.kind,cc.rank,cc.value_normalized) from public.candidate_contacts cc where cc.candidate_id=c.id and cc.kind in ('email','phone') and cc.rank is not null),'[]'::jsonb) contacts
   from public.candidates c join public.person_projection_state p on p.candidate_id=c.id
   left join public.candidate_profile_state s on s.candidate_id=c.id where c.id=any($1::uuid[])`,
        [ids.slice(offset, offset + 100)],
      )
    ).rows;
    for (const row of rows) {
      if (
        row.held ||
        row.normalized_revision == null ||
        String(row.published_revision) !== String(row.normalized_revision) ||
        projectionProfileHash(row) !== row.profile_hash
      )
        throw Error("person_profile_unavailable");
      result.set(row.id, row);
    }
  }
  return result;
}
