import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
for (const mode of [undefined, "legacy", "shadow", "live"])
  test(`actual directory CLI support-on stops before network: ${mode ?? "default"}`, () => {
    const out = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/person-directory-input/no-network.mjs",
        "scripts/sync-directory.mjs",
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          PERSON_TRANSITION_SUPPORT: "on",
          ...(mode ? { PERSON_WRITE_MODE: mode } : {}),
          COMMS_DATABASE_URL: "postgresql://synthetic@127.0.0.1:9/synthetic",
          SUPABASE_URL: "http://127.0.0.1:9",
          SUPABASE_SERVICE_ROLE_KEY: "synthetic",
          OPENAI_API_KEY: "synthetic",
        },
      },
    );
    assert.equal(out.status, 1);
    assert.match(out.stderr, /person_directory_execution_unavailable/);
    assert.doesNotMatch(out.stderr, /unexpected_network_effect/);
  });
