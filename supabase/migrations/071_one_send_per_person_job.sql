-- One Send per person per job. Transformer Talent's Send (lib/server/network.ts)
-- looks for an earlier application before it writes one, but two sends at the
-- same moment (a double click, a second tab) can both find nothing and both
-- write, leaving the same person twice in a client's pipeline. The database
-- now holds the rule: a second Send of a person to a job in the same company
-- is rejected, and the Send path answers "already sent".
--
-- Only rows the Send writes are covered (source 'transformer_talent', keyed
-- to a pool person). network.ts is the only writer of that source and always
-- writes exactly one job in role_ids, so the first element is the job.
-- Applicants and every other source are untouched. Additive: a new index,
-- nothing altered or dropped. The index cannot build over existing
-- duplicates; production had none when this was written.
create unique index if not exists website_applications_one_send_per_job
  on public.website_applications (organization_id, candidate_id, (role_ids[1]))
  where source = 'transformer_talent' and candidate_id is not null;
