-- Job workspace Task B: role-level ideal companies + hiring company name.
-- target_companies: [{name, linkedinUrl, logo}] picked in the Overview tab;
-- feeds the EM judge (unioned with per-search targets) and prefills the
-- sourcing builder. company_name: the hiring company shown in the candidate
-- drawer's pipeline table. Both dashboard-owned — the role sync chain never
-- writes them, so they survive synced-role updates.
alter table org_roles
  add column if not exists target_companies jsonb not null default '[]'::jsonb,
  add column if not exists company_name text;
