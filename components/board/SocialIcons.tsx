// Social icon cluster for the company board header (approved mock): globe
// for the org website, then the configured platforms in a fixed order. An
// icon renders only when its URL is set — one link or nine, never a
// placeholder. Glyphs are monochrome; Crunchbase is its "cb" wordmark.
import type { CompanySocials, SocialKey } from "@/lib/socials";

const GLYPHS: Record<SocialKey | "website", { label: string; node: React.ReactNode }> = {
  website: {
    label: "Website",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.7" />
        <ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M3.6 9h16.8M3.6 15h16.8" stroke="currentColor" strokeWidth="1.5" fill="none" />
      </svg>
    ),
  },
  linkedin: {
    label: "LinkedIn",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M4.98 3.5C4.98 4.88 3.87 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.24 8.25h4.52V23H.24V8.25zM8.34 8.25h4.33v2.01h.06c.6-1.14 2.08-2.34 4.28-2.34 4.58 0 5.43 3.01 5.43 6.93V23h-4.52v-7.14c0-1.7-.03-3.9-2.38-3.9-2.38 0-2.74 1.86-2.74 3.78V23H8.34V8.25z"
        />
      </svg>
    ),
  },
  x: {
    label: "X",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M18.24 2.25h3.31l-7.23 8.26L22.83 21.75h-6.66l-5.22-6.82-5.97 6.82H1.66l7.73-8.83L1.17 2.25h6.83l4.72 6.24 5.52-6.24zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z"
        />
      </svg>
    ),
  },
  github: {
    label: "GitHub",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.35.95.1-.74.4-1.25.72-1.53-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18.92-.26 1.9-.38 2.88-.39.98 0 1.96.13 2.88.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.24 2.76.12 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14 0 1.55-.02 2.79-.02 3.17 0 .31.21.67.8.55A10.51 10.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
        />
      </svg>
    ),
  },
  youtube: {
    label: "YouTube",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z"
        />
      </svg>
    ),
  },
  instagram: {
    label: "Instagram",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="5.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="17.6" cy="6.4" r="1.4" fill="currentColor" />
      </svg>
    ),
  },
  facebook: {
    label: "Facebook",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.09 10.12 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.79-4.7 4.53-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.95.93-1.95 1.89v2.26h3.32l-.53 3.49h-2.79V24C19.61 23.09 24 18.1 24 12.07z"
        />
      </svg>
    ),
  },
  glassdoor: {
    label: "Glassdoor",
    node: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          d="M15.5 3.6H8.2a3.1 3.1 0 0 0-3.1 3.1v10.6a3.1 3.1 0 0 0 3.1 3.1h7.3a3.1 3.1 0 0 0 3.1-3.1M18.6 7v6.9"
        />
      </svg>
    ),
  },
  crunchbase: {
    label: "Crunchbase",
    node: <span className="co-social-word">cb</span>,
  },
};

/** Shared with the settings editor so its field labels carry the same glyphs. */
export const SOCIAL_GLYPHS = GLYPHS;

const ORDER: (SocialKey | "website")[] = [
  "website",
  "linkedin",
  "x",
  "github",
  "youtube",
  "instagram",
  "facebook",
  "glassdoor",
  "crunchbase",
];

export default function SocialIcons({
  website,
  socials,
  orgName,
}: {
  website?: string | null;
  socials?: CompanySocials | null;
  orgName: string;
}) {
  const links = ORDER.map((key) => ({
    key,
    url: key === "website" ? website || "" : socials?.[key] || "",
  })).filter((l) => l.url);
  if (links.length === 0) return null;
  return (
    <nav className="co-socials" aria-label={`${orgName} on the web`}>
      {links.map((l) => (
        <a
          key={l.key}
          href={l.url}
          target="_blank"
          rel="noreferrer"
          title={GLYPHS[l.key].label}
          aria-label={GLYPHS[l.key].label}
        >
          {GLYPHS[l.key].node}
        </a>
      ))}
    </nav>
  );
}
