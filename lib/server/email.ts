// Transactional email via Resend. One function, one branded shell, plain
// language. Fail-soft by design: email must never break the flow that
// triggered it — callers fire and forget.
//
// From-addresses (domain mail.transformertalent.com, verified in Resend):
//   notifications@ — product emails (referrals, client requests, …)
//   signin@       — reserved for Supabase auth SMTP (configured in the
//                   Supabase dashboard, not here)

import { escapeHtml, linkedinHref, plainLine } from "./html";

const FROM_NOTIFICATIONS = "Transformer Talent <notifications@mail.transformertalent.com>";
const REPLY_TO = "spencer@transformertalent.com";

// Minimal branded shell: white card, black wordmark, no images — renders
// identically everywhere and never trips image-blocking.
function shell(bodyHtml: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e6e8ec;border-radius:12px;">
      <tr><td style="padding:26px 32px 0;">
        <span style="font-size:15px;font-weight:800;color:#111418;letter-spacing:-0.01em;">Transformer Talent</span>
      </td></tr>
      <tr><td style="padding:18px 32px 28px;font-size:14px;line-height:1.65;color:#3d434c;">
        ${bodyHtml}
      </td></tr>
    </table>
    <p style="font-size:11px;color:#8a919c;margin-top:14px;">Transformer Talent · transformertalent.com</p>
  </td></tr></table>
</body></html>`;
}

export async function sendEmail(args: {
  to: string;
  subject: string;
  /** Inner HTML placed inside the branded shell. */
  html: string;
  text?: string;
}): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        from: FROM_NOTIFICATIONS,
        to: [args.to],
        reply_to: REPLY_TO,
        subject: args.subject,
        html: shell(args.html),
        ...(args.text ? { text: args.text } : {}),
      }),
    });
    if (!res.ok) console.error("email send failed", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error("email send failed", err);
    return false;
  }
}

/** Team invitation: a branded email carrying the sign-in link. Used for the
 *  first invite and for resends alike. The company name and the inviter's
 *  address are shown as text. */
export function composeTeamInvite(args: {
  orgName: string;
  inviterEmail: string;
  actionLink: string;
}): { subject: string; html: string; text: string } {
  const org = escapeHtml(args.orgName);
  const inviter = escapeHtml(args.inviterEmail);
  // The sign-in link comes from Supabase Auth; only an https link is used.
  const link = /^https:\/\//i.test(args.actionLink) ? escapeHtml(args.actionLink) : "";
  return {
    subject: plainLine(`You have been invited to ${args.orgName} on Transformer Talent`),
    html: `
      <p style="margin:0 0 14px;"><b>${inviter}</b> invited you to join
      <b>${org}</b> on Transformer Talent.</p>
      <p style="margin:0 0 18px;">You get a dashboard for your roles and candidates, plus your own
      public recruiter page: one link with your face, your bio, and the roles you are hiring for,
      made for sharing in outreach.</p>
      <p style="margin:0 0 18px;">
        <a href="${link}"
           style="display:inline-block;background:#111418;color:#ffffff;text-decoration:none;
                  font-weight:700;font-size:14px;border-radius:8px;padding:12px 22px;">
          Accept invitation &amp; sign in
        </a>
      </p>
      <p style="margin:0;color:#8a919c;font-size:12px;">The link signs you in directly, no password
      needed. If it has expired, ask ${inviter} to resend the invitation.</p>`,
    text: `${args.inviterEmail} invited you to join ${args.orgName} on Transformer Talent.\n\nAccept and sign in: ${args.actionLink}\n\nThe link signs you in directly, no password needed. If it has expired, ask ${args.inviterEmail} to resend the invitation.`,
  };
}

export async function sendTeamInvite(args: {
  to: string;
  orgName: string;
  inviterEmail: string;
  actionLink: string;
}): Promise<boolean> {
  return sendEmail({ to: args.to, ...composeTeamInvite(args) });
}

/** Referral confirmation to the referrer (identical for duplicates — the
 *  response never reveals whether we already knew the person). The name and
 *  profile come from a public form: shown as text, and the profile link is
 *  rebuilt from the LinkedIn name. */
export function composeReferralConfirmation(args: {
  referrerName: string;
  candidateLinkedin: string;
  /** null = no bounty was offered (org-board referrals) — say nothing about money. */
  amount: number | null;
}): { subject: string; html: string; text: string } {
  const first = plainLine(args.referrerName.split(/\s+/)[0] || args.referrerName, 60);
  const profile = linkedinHref(args.candidateLinkedin);
  const amount = args.amount != null && Number.isFinite(args.amount) ? Math.round(args.amount) : null;
  const moneyHtml =
    amount != null
      ? `
      <p style="margin:0 0 14px;">If your referral leads to a placement, you receive
      <b style="color:#067647;">$${amount.toLocaleString()}</b>, paid when the placement completes.</p>`
      : "";
  const moneyText =
    amount != null
      ? `\n\nIf your referral leads to a placement, you receive $${amount.toLocaleString()}, paid when the placement completes.`
      : "";
  const profileHtml = profile
    ? ` (<a href="${escapeHtml(profile)}" style="color:#2a5bd7;">${escapeHtml(profile)}</a>)`
    : "";
  return {
    subject: "We received your referral",
    html: `
      <p style="margin:0 0 14px;">Hi ${escapeHtml(first)},</p>
      <p style="margin:0 0 14px;">Thank you for your referral. Our team will review their profile${profileHtml}
      and reach out to them if there is a fit.</p>${moneyHtml}
      <p style="margin:0;">Spencer<br>Transformer Talent</p>`,
    text: `Hi ${first},\n\nThank you for your referral. Our team will review their profile${profile ? ` (${profile})` : ""} and reach out to them if there is a fit.${moneyText}\n\nSpencer\nTransformer Talent`,
  };
}

export async function sendReferralConfirmation(args: {
  to: string;
  referrerName: string;
  candidateLinkedin: string;
  /** null = no bounty was offered (org-board referrals) — say nothing about money. */
  amount: number | null;
}): Promise<void> {
  await sendEmail({ to: args.to, ...composeReferralConfirmation(args) });
}
