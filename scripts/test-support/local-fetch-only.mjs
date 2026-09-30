// Test preload: the actual worker and shared library may call only our local fixture.
const realFetch = globalThis.fetch;
const allowed = new URL(process.env.SUPABASE_URL).origin;
if (!allowed.startsWith("http://127.0.0.1:")) throw new Error("Local test URL required");
globalThis.fetch = (input, init) => {
  if (new URL(typeof input === "string" ? input : input.url ?? input).origin !== allowed) {
    throw new Error("EXTERNAL_FETCH_FORBIDDEN");
  }
  return realFetch(input, init);
};
