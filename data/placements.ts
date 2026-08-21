export interface Placement {
  company: string;
  url: string;
  role: string;
  line: string;
  tag: string;
}

export const PLACEMENTS: Placement[] = [
  {
    company: "Fleet AI",
    url: "https://www.fleetai.com/",
    role: "ML Infrastructure Engineer",
    line: "The engineer now running ML infrastructure end to end.",
    tag: "ML_INFRA",
  },
  {
    company: "Ironsite",
    url: "https://ironsite.ai/",
    role: "Chief Science Officer",
    line: "An executive search at the applied-AI frontier.",
    tag: "EXEC",
  },
  {
    company: "Virtualitics",
    url: "https://www.virtualitics.com/",
    role: "ML Engineer",
    line: "Machine learning for AI-driven analytics.",
    tag: "ML",
  },
  {
    company: "Adaptive",
    url: "https://www.adaptive.co/",
    role: "Product Engineer",
    line: "The full-stack generalist a design-led team wanted.",
    tag: "PRODUCT",
  },
  {
    company: "Palantir",
    url: "https://www.palantir.com/",
    role: "Forward Deployed Engineer",
    line: "High-bar FDE hiring from a live, pre-qualified pipeline.",
    tag: "FDE",
  },
];
