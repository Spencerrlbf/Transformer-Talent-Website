import type { Metadata } from "next";
import TalentMatcher from "@/components/TalentMatcher";

export const metadata: Metadata = {
  title: "Instant Talent Match",
  description:
    "Paste a job description and instantly see anonymized profiles of matching AI/ML and software engineers from a network of 400,000+.",
};

export default function TalentPage() {
  return (
    <main className="page-main">
      <h1 className="page-title">Instant Talent Match</h1>
      <p className="page-intro">
        Paste your job description and we&apos;ll match it against our network
        of 400,000+ engineering profiles — instantly, and anonymized. If you
        like what you see, one call gets you the introductions.
      </p>
      <TalentMatcher />
      <p className="page-intro" style={{ marginTop: "2.5rem", fontSize: "0.75rem" }}>
        Your JD is stored so we can follow up with a hand-picked shortlist.
        Profiles shown are anonymized summaries; we never share candidate
        identities without their consent.
      </p>
    </main>
  );
}
