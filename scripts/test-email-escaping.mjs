#!/usr/bin/env node
// Every email built from outside text (form fields, company names, job
// titles) shows that text as text. Feeds hostile values into each builder
// and checks the HTML: no markup gets through, and every link is one we
// built (mailto:, the rebuilt LinkedIn profile, our own dashboard).
//
//   node scripts/test-email-escaping.mjs
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "scripts/dist/email-escaping-entry.ts");
const fs = await import("node:fs");
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(
  entry,
  `export { composeLeadNotification } from "@/lib/server/lead-notify";
export { composeTeamInvite, composeReferralConfirmation } from "@/lib/server/email";
export { escapeHtml, linkedinHref, mailtoHref, jsonForScript } from "@/lib/server/html";
`
);
execFileSync("npx", ["--yes", "esbuild@0.28.2", entry, "--bundle", "--platform=node", "--format=esm",
  `--alias:@=${root}`, "--outfile=scripts/dist/email-escaping.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });
const m = await import(path.join(root, "scripts/dist/email-escaping.mjs"));

const EVIL = `Jane<script>alert(1)</script><img src=x onerror=alert(2)><a href="https://evil.example/x">View resume</a>"'`;
const fails = [];
const check = (name, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fails.push(name);
};
const ALLOWED_HREF = /^(mailto:[^\s"<>]+|https:\/\/www\.linkedin\.com\/in\/[^\s"<>]+|https:\/\/www\.transformertalent\.com\/dashboard[^\s"<>]*|https:\/\/[a-z0-9.-]+\.supabase\.co\/auth\/v1\/verify\?[^\s"<>]+)$/;
function clean(label, html) {
  // Only real tags matter: escaped text ("&lt;img onerror=...") is shown, never run.
  const tags = html.match(/<[a-zA-Z][^>]*>/g) || [];
  check(`${label}: no script/img/iframe/style tag`, !tags.some((t) => /^<\s*(script|img|iframe|style|svg|object|embed|form|input)\b/i.test(t)));
  check(`${label}: no event handler attribute on any tag`, !tags.some((t) => /\son[a-z]+\s*=/i.test(t)));
  check(`${label}: only the tags our templates use`, tags.every((t) => /^<(p|b|br|a)[\s>]/i.test(t)));
  check(`${label}: no javascript: or data: link`, !/(javascript|data|vbscript):/i.test(html));
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((x) => x[1].replace(/&amp;/g, "&"));
  check(`${label}: every link is one we built (${hrefs.length})`, hrefs.every((h) => ALLOWED_HREF.test(h)));
  check(`${label}: the hostile text shows as text`, html.includes("&lt;script&gt;") || !html.includes("script"));
}

// Lead emails: every kind, every typed field hostile.
for (const kind of ["application", "speculative", "referral", "future"]) {
  const { subject, html } = m.composeLeadNotification({
    to: ["x@example.com"],
    kind,
    name: EVIL,
    email: `x@example.com"><script>alert(3)</script>`,
    linkedin: `javascript:alert(4)//linkedin.com/in/jane-doe`,
    roleTitles: [`<b onmouseover=alert(5)>Staff Engineer</b>`, EVIL],
    referrerName: EVIL,
    referrerEmail: `r@example.com<img src=x>`,
    followUpAt: "2027-01-01",
    preferredRoles: [EVIL],
    preferredLocations: [`<script>x</script>`],
    preferredWorkplace: ["remote"],
    salaryFloor: `<a href="https://evil.example">$1</a>`,
    visaStatus: EVIL,
    viaPage: false,
  });
  clean(`lead email (${kind})`, html);
  check(`lead email (${kind}): subject is one plain line`, !/[\r\n]/.test(subject) && subject.length <= 200);
  check(`lead email (${kind}): LinkedIn rebuilt from the profile name`, html.includes("https://www.linkedin.com/in/jane-doe"));
}
// A non-LinkedIn "profile" gets no link at all.
{
  const { html } = m.composeLeadNotification({ to: [], kind: "application", name: "A", email: "a@b.co", linkedin: "https://evil.example/in/jane", roleTitles: ["R"], viaPage: true });
  check("lead email: a non-LinkedIn profile gets no link", !html.includes("evil.example"));
}

// Team invite: company name and inviter shown as text; only an https sign-in link.
{
  const t = m.composeTeamInvite({ orgName: EVIL, inviterEmail: `a@b.co<script>x</script>`, actionLink: "https://kmuihequfurvjxpnugxf.supabase.co/auth/v1/verify?token=abc&type=invite" });
  clean("team invite", t.html);
  const bad = m.composeTeamInvite({ orgName: "Acme", inviterEmail: "a@b.co", actionLink: "javascript:alert(1)" });
  check("team invite: a non-https sign-in link is dropped", !bad.html.includes("javascript:"));
}

// Referral confirmation: the referrer's name and the profile link.
{
  const r = m.composeReferralConfirmation({ referrerName: EVIL, candidateLinkedin: `https://www.linkedin.com/in/jane-doe"><script>x</script>`, amount: 5000 });
  clean("referral confirmation", r.html);
  const none = m.composeReferralConfirmation({ referrerName: "Sam", candidateLinkedin: "https://evil.example/profile", amount: null });
  check("referral confirmation: a non-LinkedIn profile gets no link", !none.html.includes("evil.example"));
}

// Helpers.
check("mailtoHref refuses an address with markup", m.mailtoHref(`a@b.co"><x`) === null);
check("linkedinHref refuses a profile name with markup", m.linkedinHref(`linkedin.com/in/<script>`) === null);
check("jsonForScript cannot close the script tag", !m.jsonForScript({ t: "</script><script>alert(1)</script>" }).includes("</script>"));

fs.rmSync(entry, { force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
