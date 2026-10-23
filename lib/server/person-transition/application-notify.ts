import { sbRest } from '../supabase';
import { TT_ORG_ID } from '../person/normalize';
import { leadRecipients, sendLeadNotification } from '../lead-notify';
import type { ApplicantPipelineInput } from '../applicant-pipeline';

/** Original request callback only. Processing recovery never sends this notice.
 * Best effort remains best effort: there is no provider idempotency/outbox claim. */
export async function notifyAcceptedApplication(p: ApplicantPipelineInput): Promise<void> {
  if (p.fromQueue || p.applicationType === 'Referral') return;
  const org = p.boardOrg?.id ?? p.orgId ?? TT_ORG_ID;
  try {
    const response = await sbRest(`website_applications?id=eq.${p.submissionId}&organization_id=eq.${org}&select=name,email,linkedin_url,source,role_ids,role_titles,recruiter_profile_id,follow_up_at,preferred_roles,preferred_locations,preferred_workplace,comp_expectation,visa_status`);
    if (!response.ok) return;
    const [row] = await response.json();
    if (!row || String(row.source || '').startsWith('referral:')) return;
    const future = row.source === 'future';
    const speculative = future || String(row.source || '').startsWith('speculative') || !row.role_ids?.length;
    const to = await leadRecipients({ orgId: org, recruiterProfileId: row.recruiter_profile_id, jobIds: row.role_ids || [] });
    await sendLeadNotification({ to, kind: future ? 'future' : speculative ? 'speculative' : 'application',
      name: row.name || '', email: row.email, linkedin: row.linkedin_url || '', roleTitles: row.role_titles || [],
      followUpAt: future ? row.follow_up_at || undefined : undefined,
      preferredRoles: future ? row.preferred_roles || [] : undefined,
      preferredLocations: future ? row.preferred_locations || [] : undefined,
      preferredWorkplace: future ? row.preferred_workplace || [] : undefined,
      salaryFloor: future ? row.comp_expectation : null, visaStatus: future ? row.visa_status : null,
      viaPage: Boolean(row.recruiter_profile_id) });
  } catch { console.error('application_acceptance_notice_failed'); }
}
