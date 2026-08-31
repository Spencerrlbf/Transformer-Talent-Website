// Cloudflare Turnstile verification for the public write endpoints. Deliberate
// failure posture: no secret configured = captcha disabled (skip, warn once),
// and a Cloudflare outage or network error must never block a real candidate —
// rate limiting still stands behind it. Only a definite "not a human" verdict
// (or a missing/garbage token while captcha is enabled) rejects.
let warned = false;

export async function verifyTurnstile(token: unknown): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (!warned) {
      console.warn("TURNSTILE_SECRET_KEY not set; captcha verification is off");
      warned = true;
    }
    return true;
  }
  if (typeof token !== "string" || !token || token.length > 4096) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return true;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return true;
  }
}
