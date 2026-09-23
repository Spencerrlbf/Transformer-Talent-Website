-- Company snapshot columns (additive). The report card's company hover shows
-- the headquarters, website and company type from the company's LinkedIn
-- page; company_context keeps them beside the facts the judge already reads.
-- Rows cached before this migration have all three null: the next live
-- lookup fetches the page again and fills them in (see
-- lib/server/sourcing/company-context.ts).
alter table public.company_context add column if not exists hq text, add column if not exists website text, add column if not exists company_type text;
