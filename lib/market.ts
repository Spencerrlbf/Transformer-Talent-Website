import marketData from "@/data/market-index.json";

export interface Band {
  family: string;
  city: string;
  roles: number;
  medianMin: number;
  medianMax: number;
  topOfMarket: number;
}

export interface FamilyPage {
  slug: string;
  family: string;
  title: string;
  keyword: string;
  intro: string;
  read: string;
}

// One SEO landing page per role family, each targeting a real search query.
// All numbers come from data/market-index.json (computed from live searches).
export const FAMILY_PAGES: FamilyPage[] = [
  {
    slug: "forward-deployed-engineer-salary",
    family: "Forward Deployed Engineering",
    title: "Forward Deployed Engineer Salary Guide",
    keyword: "forward deployed engineer salary",
    intro:
      "Forward Deployed Engineers (FDEs) sit between engineering and the customer — shipping real solutions on top of a product, in the field. Comp data below comes from live FDE searches we have run for VC-backed startups, not from scraped job posts.",
    read:
      "FDE bands have the widest spread of any engineering family we place. Entry bands start well below product engineering, but senior operators who own major accounts clear $300–400k base — titles are unstandardized, so great FDEs are priced by impact, not by band.",
  },
  {
    slug: "machine-learning-engineer-salary",
    family: "ML / AI Engineering & Research",
    title: "ML & AI Engineer Salary Guide",
    keyword: "machine learning engineer salary",
    intro:
      "ML and AI engineering comp is moving faster than any salary survey can track. The bands below come from AI/ML searches we have run for VC-backed startups — what companies actually authorized us to offer, updated as searches run.",
    read:
      "San Francisco carries the widest ML bands — research-adjacent roles at funded labs reach $450k base, while product-ML roles cluster far lower. If a company is quoting you a survey median, it is probably a year stale.",
  },
  {
    slug: "backend-infrastructure-engineer-salary",
    family: "Infrastructure / Backend",
    title: "Backend & Infrastructure Engineer Salary Guide",
    keyword: "infrastructure engineer salary",
    intro:
      "Infrastructure and backend engineers are the most consistently bid-up profile in our searches. These bands come from live infra/backend searches for VC-backed startups.",
    read:
      "SF infra is the strongest market we see: median authorized bands of $192–252k with outliers to $600k for staff-plus infrastructure at well-funded companies. Hiring infra in SF under a $180k ceiling means losing candidates weekly.",
  },
  {
    slug: "software-engineer-startup-salary",
    family: "Product / Full-Stack",
    title: "Startup Software Engineer Salary Guide",
    keyword: "startup software engineer salary",
    intro:
      "Product and full-stack engineers make up the largest share of our searches. The bands below reflect what VC-backed startups actually authorized us to offer across seniority levels.",
    read:
      "Product engineering comp is barbell-shaped: seed-stage founding engineers trade base for equity, while growth-stage companies pay $170–255k medians in SF with top-of-market offers reaching $500k for staff-level product engineers.",
  },
];

export function bandsFor(family: string): Band[] {
  return (marketData as Band[]).filter((b) => b.family === family);
}

export function allBands(): Band[] {
  return marketData as Band[];
}
