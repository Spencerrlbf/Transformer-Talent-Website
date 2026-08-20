-- Task F: the wire between TT's copy of a job and the client org's copy.
-- {orgId, jobId} of the client's role. When set, the Network page's
-- send-to-job files the application (and its fit verdict) in the CLIENT
-- org, so the candidate appears in their pipeline. Dashboard-owned;
-- never written by the role sync chain.
alter table org_roles add column if not exists linked_org_role jsonb;
