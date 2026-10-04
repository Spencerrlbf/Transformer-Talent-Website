# Disposable local environment for the leak test and runtime attestation

Zero-cost, loopback-only Supabase stack (Auth, REST, Storage, PostgreSQL) plus the
exact production build of this branch. Nothing here can reach a hosted project:
`PERSON_TARGET_PROJECT_REF=local` accepts loopback clients only, and
`OUTBOUND_DENY_HOSTS` refuses every provider host at `fetch`.

```sh
# 1. Local stack (Docker). Ports in supabase/config.toml must be free on this machine.
supabase init                                   # once; config.toml stays uncommitted
cp scripts/tenancy/local-bootstrap.sql supabase/migrations/000_local_bootstrap.sql   # local only, never commit
supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,edge-runtime,realtime,postgres-meta
# -> installs 000 (base tables that predate the repo's migrations) and 001 … 20261003* in order
curl -X POST "$SUPABASE_URL/storage/v1/bucket" -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
  -H 'Content-Type: application/json' -d '{"id":"resumes","name":"resumes","public":false}'   # buckets are project settings

# 2. Environment file (mode 600): SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL = the local API URL,
#    the local anon/service keys, PERSON_DATABASE_URL = PERSON_PUBLISH_DATABASE_URL =
#    LOCAL_DATABASE_URL = the local PostgreSQL URL, PERSON_TARGET_PROJECT_REF=local,
#    OUTBOUND_DENY_HOSTS=api.us.nylas.com,api.resend.com,.airtable.com,api.harvest-api.com,api.openai.com,api.cloud.llamaindex.ai,api.typesafe.ai
#    PERSON_WRITE_MODE=live PERSON_TRANSITION_SUPPORT=on, placeholder NYLAS_*/RESEND_API_KEY so the
#    email routes run (the deny list refuses the provider), Cloudflare's Turnstile test keys.

# 3. Exact artifact: production build with the NEXT_PUBLIC values, then `next start`.
# 4. Leak test, disabled and armed (the fixture points at the same local stack):
node scripts/test-tenancy.mjs --base http://127.0.0.1:3400
supabase db reset && <recreate the resumes bucket>      # the armed run wants a clean queue
PINNED_RUNNER_DIR=<c4d0e4e checkout> LOCAL_DATABASE_URL=<local pg> PERSON_TARGET_PROJECT_REF=local \
  node scripts/test-tenancy.mjs --base http://127.0.0.1:3400 --armed
# 5. Runtime attestation: person_target_identity() through REST and PostgreSQL must agree;
#    the same build started with PERSON_TARGET_PROJECT_REF naming another project must
#    refuse the first signed-in request (person_target:rest_mismatch) and a provider-bound
#    route must log outbound_denied:<host>.
supabase stop                                   # disposes of everything
```

What this proves: the exact commit's server and database behaviour (tenancy, armed
controller, gate, deny list). What it does not prove: the Vercel-hosted deployment's own
configuration, which needs the same identity comparison and gate probe against the
deployment that will serve traffic.
