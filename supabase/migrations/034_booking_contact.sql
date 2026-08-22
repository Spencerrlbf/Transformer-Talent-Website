-- Recruiter page booking + contact: a pasted scheduling link (cal.com,
-- Calendly, Google appointment schedule, anything https) rendered as the
-- page's "Book a call" action, and a public contact email for the
-- copy-to-clipboard Email button. Both optional; empty = button hidden.
alter table recruiter_profiles
  add column if not exists booking_url text,
  add column if not exists contact_email text;
