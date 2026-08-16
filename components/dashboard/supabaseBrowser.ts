"use client";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Browser client used ONLY for auth (magic link + session). All data access
// goes through /api/dashboard/* routes, which verify the token server-side.
let client: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }
  return client;
}
