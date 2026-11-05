import { Pool } from "pg";
import { SUPABASE_CA } from "./supabase-ca";

// The paused site's only database connection: a restricted role that can
// insert and read the applications tables and nothing else. One small pool
// per server instance; every call is a single short statement.
let pool: Pool | null = null;

export function applicationsDb(): Pool {
  if (pool) return pool;
  const url = process.env.APPLICATIONS_DATABASE_URL;
  if (!url) throw new Error("APPLICATIONS_DATABASE_URL is not set");
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  u.searchParams.delete("sslrootcert");
  pool = new Pool({
    connectionString: u.toString(),
    ssl: { rejectUnauthorized: true, ca: SUPABASE_CA },
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  return pool;
}
