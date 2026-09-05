-- Drop the button-to-template mapping (applied 2026-09-03, same day as 052).
-- Nobody should have to tell the app which wording a button uses: each button
-- carries its own default, and the composer's Template dropdown lets anyone
-- swap wording at send time. The table was never referenced by any code on
-- main, so dropping it cannot affect production.
drop table if exists public.quick_action_templates;
