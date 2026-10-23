import type { Metadata } from "next";
import TalentMatcher from "@/components/TalentMatcher";

export const metadata: Metadata = {
  title: "See Potential Matches",
  description:
    "Upload a job description and we'll share anonymized profiles of AI/ML and software engineers from our network who could fit your role.",
};

export default function TalentPage() {
  return (
    <main className="page">
      <div className="wrap">
        <div className="ab-head">
          <h1 className="h-page">
            See potential <span>matches</span>
          </h1>
          <p className="page-intro">
            Upload your job description and we&apos;ll share a few potential
            matches from our network — <b>anonymized, in seconds, no call
            required</b>. Like what you see? One conversation gets you the
            introductions.
          </p>
        </div>
        <TalentMatcher />
        <p className="tal-reassure">
          Your JD is stored so we can follow up with a hand-picked shortlist.
          Profiles shown are anonymized summaries; candidate identities are
          never shared without their consent.
        </p>
      </div>
    </main>
  );
}
