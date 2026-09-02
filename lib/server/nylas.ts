// Nylas v3 client for send-as-you email. Each seat OAuths their own
// Gmail/Outlook through Nylas hosted auth; we store the resulting grant id
// and send through it. Unlike transactional email (email.ts, fail-soft),
// sends here surface errors to the composer — a recruiter must know their
// outreach didn't go.
import { createHmac, timingSafeEqual } from "crypto";

const API = "https://api.us.nylas.com";

const apiKey = () => process.env.NYLAS_API_KEY || "";
const clientId = () => process.env.NYLAS_CLIENT_ID || "";

export const emailConfigured = () => Boolean(apiKey() && clientId());

async function nylas(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    signal: AbortSignal.timeout(20_000),
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
}

/** Origin the browser is actually on (localhost / preview alias / www) —
 *  the OAuth redirect_uri must match one of the URIs registered on the
 *  Nylas app, and it must be identical at auth and token-exchange time. */
export function requestOrigin(req: Request): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

// ---- hosted OAuth -----------------------------------------------------

/** State ties the callback to the seat that started it (the callback
 *  arrives as a bare browser redirect, with no dashboard auth attached). */
export function signState(orgId: string, memberEmail: string): string {
  const ts = Date.now();
  const payload = `${orgId}|${memberEmail}|${ts}`;
  const mac = createHmac("sha256", apiKey()).update(payload).digest("hex");
  return Buffer.from(`${payload}|${mac}`).toString("base64url");
}

export function verifyState(state: string): { orgId: string; memberEmail: string } | null {
  let raw = "";
  try {
    raw = Buffer.from(state, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = raw.split("|");
  if (parts.length !== 4) return null;
  const [orgId, memberEmail, ts, mac] = parts;
  const expect = createHmac("sha256", apiKey()).update(`${orgId}|${memberEmail}|${ts}`).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Date.now() - Number(ts) > 15 * 60_000) return null;
  return { orgId, memberEmail };
}

export function authUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });
  return `${API}/v3/connect/auth?${q}`;
}

export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<{ grantId: string; address: string; provider: string } | null> {
  const res = await nylas("/v3/connect/token", {
    method: "POST",
    body: JSON.stringify({
      client_id: clientId(),
      client_secret: apiKey(),
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    console.error("nylas token exchange failed", res.status, await res.text());
    return null;
  }
  const data = (await res.json()) as { grant_id?: string; email?: string; provider?: string };
  if (!data.grant_id) return null;
  return { grantId: data.grant_id, address: data.email || "", provider: data.provider || "" };
}

export async function deleteGrant(grantId: string): Promise<void> {
  await nylas(`/v3/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" }).catch(() => {});
}

// ---- sending ----------------------------------------------------------

export async function sendAsGrant(args: {
  grantId: string;
  to: { email: string; name?: string };
  subject: string;
  html: string;
  /** Send as a true reply: threads in the provider's inbox and keeps one
   *  thread_id on our side. */
  replyToMessageId?: string;
}): Promise<{ messageId: string; threadId: string } | { error: string }> {
  const res = await nylas(`/v3/grants/${encodeURIComponent(args.grantId)}/messages/send`, {
    method: "POST",
    body: JSON.stringify({
      to: [args.to.name ? { email: args.to.email, name: args.to.name } : { email: args.to.email }],
      subject: args.subject,
      body: args.html,
      ...(args.replyToMessageId ? { reply_to_message_id: args.replyToMessageId } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("nylas send failed", res.status, text);
    // 401/403 = grant revoked or expired: the seat must reconnect.
    if (res.status === 401 || res.status === 403) return { error: "grant_invalid" };
    return { error: "send_failed" };
  }
  const json = (await res.json()) as { data?: { id?: string; thread_id?: string } };
  return { messageId: json.data?.id || "", threadId: json.data?.thread_id || "" };
}

/** Full message (the webhook payload may omit the body). */
export async function fetchMessage(
  grantId: string,
  messageId: string
): Promise<{ body: string; subject: string; snippet: string; threadId: string } | null> {
  const res = await nylas(
    `/v3/grants/${encodeURIComponent(grantId)}/messages/${encodeURIComponent(messageId)}?fields=standard`
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: { body?: string; subject?: string; snippet?: string; thread_id?: string };
  };
  const d = json.data;
  if (!d) return null;
  return { body: d.body || "", subject: d.subject || "", snippet: d.snippet || "", threadId: d.thread_id || "" };
}

// ---- webhooks ---------------------------------------------------------

/** Nylas signs the raw body with the webhook secret (HMAC-SHA256 hex). */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.NYLAS_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expect = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signature.trim());
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}
