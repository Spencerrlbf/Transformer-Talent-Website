import type { Metadata } from "next";
import TalentMatcher from "@/components/TalentMatcher";

export const metadata: Metadata = {
  title: "Run Match",
  description:
    "Paste a job description and instantly see anonymized profiles of matching AI/ML and software engineers from a network of 419,000+.",
};

export default function TalentPage() {
  return (
    <main className="page">
      <div className="wrap">
        <h1 className="h-page b1">
          Run <span>match</span>
        </h1>
        <p className="page-intro b2">
          Paste your job description. The engine scans <b>419,595 profiles</b>{" "}
          and returns the top matches — anonymized, in about ten seconds. Like
          what you see? One call gets you the introductions.
        </p>
        <div className="b3">
          <TalentMatcher />
        </div>
        <p
          className="page-intro"
          style={{ marginTop: "2.4rem", fontSize: "0.7rem", color: "var(--fog-30)" }}
        >
          Your JD is stored so we can follow up with a hand-picked shortlist.
          Profiles shown are anonymized summaries; candidate identities are
          never shared without their consent.
        </p>
      </div>
    </main>
  );
}
