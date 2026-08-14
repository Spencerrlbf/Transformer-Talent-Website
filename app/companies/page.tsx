import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "For Companies",
  description:
    "Hire AI/ML and software engineers through Transformer Talent. High-intent, pre-qualified candidates from a network of 400,000+ engineers.",
};

const STEPS = [
  {
    title: "Tell us the role",
    body: "A JD, a call, or a couple of paragraphs — enough to understand what great looks like for you.",
  },
  {
    title: "We shortlist from our network",
    body: "400,000+ enriched engineering profiles, plus candidates already in active conversation with us. No job-board spray.",
  },
  {
    title: "You interview high-intent candidates",
    body: "Every profile we send is pre-qualified on comp, location, and motivation — most clients interview the first batch within days.",
  },
];

export default function CompaniesPage() {
  return (
    <main className="page-main">
      <h1 className="page-title">Hire With Us</h1>
      <p className="page-intro">
        We place AI/ML and software engineers with startups backed by Y
        Combinator, Sequoia, a16z, General Catalyst, and 8VC. Specialist
        search, founder-level responsiveness, no retained-search theater.
      </p>

      <div className="roles-grid" style={{ marginBottom: "3rem" }}>
        {STEPS.map((step, i) => (
          <div key={step.title} className="role-card" style={{ cursor: "default" }}>
            <div className="role-meta" style={{ marginBottom: "0.5rem" }}>
              <span className="role-salary">0{i + 1}</span>
            </div>
            <div className="role-title">{step.title}</div>
            <p style={{ fontSize: "0.8rem", color: "var(--cream-dim)" }}>
              {step.body}
            </p>
          </div>
        ))}
      </div>

      <div className="cta-group" style={{ justifyContent: "flex-start" }}>
        <a href="/talent" className="cta cta-primary">
          Try an instant match →
        </a>
        <a
          href="mailto:spencer@transformertalent.com?subject=Hiring%20inquiry"
          className="cta"
        >
          Start a search →
        </a>
      </div>
    </main>
  );
}
