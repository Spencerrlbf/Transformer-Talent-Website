// Every string on the homepage. Pattern per section: the inference term is
// the eyebrow, the heading says what it is in hiring, "means" says what the
// term is in our process, "getsYou" says what the client gets. The audience
// runs inference for a living, so the terms themselves are never explained.
// No em-dashes. No internal tooling. Numbers come from lib/home/placeholders.
import { numberWord, PRICING_CONFIRMED, SHORTLIST_SIZE } from "./placeholders";

export const CONTACT_HREF = "mailto:spencer@transformertalent.com?subject=Brief";
export const SEND_BRIEF_HREF = "/talent";

export const NAV = {
  brand: "Transformer Talent",
  links: [
    { label: "For hiring managers", href: "/talent" },
    { label: "For engineers", href: "/roles" },
    { label: "About", href: "/about" },
  ],
  login: { label: "Log in", href: "/dashboard" },
  cta: { label: "Book a call", href: CONTACT_HREF },
};

export const CTA = {
  sendBrief: { label: "Send a brief", href: SEND_BRIEF_HREF },
  bookCall: { label: "Book a call", href: CONTACT_HREF },
  viewRoles: { label: "View all roles", href: "/roles" },
  sampleProfile: { label: "Read a sample profile", href: "#" },
};

export const HERO = {
  headlineBefore: "The ",
  headlineAccent: "inference layer",
  headlineAfter: " for hiring.",
  sub: "Talent infrastructure for teams that develop, train, and serve. Senior AI and software engineers, placed at venture-backed start-ups. Pay on hire.",
  means:
    "The inference layer means we sit between the market and your headcount, holding your brief and reading every profile against it.",
  getsYou: "You brief us once, and every profile arrives already checked against what you said.",
  stageAria:
    "One search end to end: the brief is typed once, the first profile arrives, a review is appended, and a second role starts warm.",
  footnote: "Timing illustrative until measured from role data.",
};

export const PROOF = {
  lead: "Placements at companies backed by",
  investors: ["Sequoia", "8VC", "Felicis", "Y Combinator", "a16z"],
};

export type Fact = { title: string; body: string };
export type Tab = {
  id: string;
  label: string;
  heading: string;
  sub: string;
  means: string;
  getsYou: string;
  demo: string;
  facts: Fact[];
};
export type Section = {
  id: string;
  eyebrow: string;
  heading: string;
  sub: string;
  means: string;
  getsYou: string;
  demo: string;
  buildStep: number;
  facts: Fact[];
  cta: { label: string; href: string };
  tabs?: Tab[];
  tone?: "dark" | "light";
};

export const KV_CACHE: Section = {
  id: "kv-cache",
  eyebrow: "kv cache",
  heading: "The memory of the search.",
  sub: "Nothing you tell us is thrown away while the role is open.",
  means:
    "The KV cache means your brief and every review you give are held as one record for the life of the role.",
  getsYou: "You explain the role once, and each profile knows what the last one taught us.",
  demo: "One stage with four tabs: the brief held at prefill, profiles decoded against it, reviews appended, a second role starting warm. Readout on every tab: evicted 0.",
  buildStep: 8,
  facts: [],
  cta: CTA.sendBrief,
  tabs: [
    {
      id: "prefill",
      label: "Prefill",
      heading: "The kickoff call is the prefill.",
      sub: "One call reads the whole brief: the team, the bar, the compensation, why the last hire left.",
      means:
        "Prefill means the expensive pass over your brief happens once, at kickoff, and is held for the whole role.",
      getsYou: "You explain the role once. Nobody at our end asks you to repeat it.",
      demo: "A kickoff brief typed once and held as the memory of the search.",
      facts: [
        { title: "Read once.", body: "The team, the bar, the compensation and the last hire, held for the whole role." },
        { title: "Already read.", body: "The market side was read before your brief arrived. Your brief is the only cold input." },
        { title: "One call.", body: "The kickoff is the only pass you sit through." },
      ],
    },
    {
      id: "decode",
      label: "Decode",
      heading: "Every profile is read against your brief.",
      sub: "Each profile is checked against the brief we hold, never against a fresh read of it.",
      means:
        "Decode means every profile after kickoff is produced from the held brief, so profile one and profile nine are checked against the same words.",
      getsYou: "Profiles that agree with each other and with what you said, each with the reason written down.",
      demo: "Profiles travel from the field into the shortlist slots; a thin market sends a market read instead.",
      facts: [
        { title: "Your words.", body: "Checked against your words, not against a job title." },
        { title: "A profile or a market read.", body: "When the market is thin you get the truth in the same window." },
        { title: "Why them, why now, check first.", body: "The reason arrives with every profile." },
      ],
    },
    {
      id: "append",
      label: "Append",
      heading: "Your review is appended to the cache.",
      sub: "Pass or progress, with your reason, is written into the search the moment you send it.",
      means: "Append means nothing you tell us is thrown away, and nothing is evicted while the role is open.",
      getsYou: "The next profile already knows what the last one taught us.",
      demo: "Two replies land as new cells in the cache; matching profiles step up; nothing goes dark.",
      facts: [
        { title: "Two words is enough.", body: "A reason makes the next profile sharper." },
        { title: "Nothing evicted while the role is open.", body: "We do not forget what senior means to you between batches." },
        { title: "Your reason, in your words.", body: "We hold it as you wrote it." },
      ],
    },
    {
      id: "warm-start",
      label: "Warm start",
      heading: "A second role at your company starts warm.",
      sub: "Role two shares the prefix with role one: the team, the bar, and how you decide.",
      means: "Warm start means the second brief only needs the fields that differ.",
      getsYou: "A shorter kickoff for role two, and a first profile sooner.",
      demo: "Two lanes of cache cells; role two appears with the shared cells already lit.",
      facts: [
        { title: "Shared prefix.", body: "Team, bar and how you decide carry over unchanged." },
        { title: "Only the delta is cold.", body: "Title, level and compensation for the new role." },
        { title: "Same terms.", body: "Pay on hire." },
      ],
    },
  ],
};

const K = numberWord(SHORTLIST_SIZE);
const K_LOWER = K.toLowerCase();
const K_HUNDRED = numberWord(SHORTLIST_SIZE * 100);

export const TOP_K: Section = {
  id: "top-k",
  eyebrow: "top-k",
  heading: `${K} profiles, not ${K_HUNDRED}.`,
  sub: "You see the top of the distribution, not the distribution.",
  means: "k is the shortlist: the few profiles at the top for your role, with everything below the cut held back.",
  getsYou: `You spend the week on ${K_LOWER} conversations worth having, not on reading ${K_HUNDRED} profiles yourself.`,
  demo: `${K} cards rise above a line labelled held back, each with its reason. A thin market sends a market read instead.`,
  buildStep: 9,
  facts: [
    { title: "Below the cut stays below the cut.", body: `You see ${K_LOWER} profiles, not ${K_HUNDRED}.` },
    { title: "When k is zero, we say so.", body: "A thin market gets a market read, never a name to fill the slot." },
    { title: "Each pick names its lines.", body: "Each pick names the lines of your brief that put it there." },
  ],
  cta: CTA.sendBrief,
};

export const ATTENTION: Section = {
  id: "attention",
  eyebrow: "attention",
  heading: "Every profile ships with why.",
  sub: "Which lines in your brief put each person on the list.",
  means: "Attention is the weight of each phrase in your brief in the written reason for a profile.",
  getsYou: "You progress or pass in two minutes, and your reason goes straight back into the search.",
  demo: "Hover a phrase from the sample brief and the field rises where it matters; hover a profile and the phrases that put it there brighten.",
  buildStep: 9,
  facts: [
    { title: "Why them.", body: "The specific match to your bar, not the resume restated." },
    { title: "Why now.", body: "What we know about their timing and what would move them." },
    { title: "Check first.", body: "The one thing we could not verify, named, so the first call is not wasted." },
  ],
  cta: CTA.sendBrief,
};

export const MARKET: Section = {
  id: "market",
  eyebrow: "market",
  heading: "Read before your brief arrives.",
  sub: "Most of the work in a search is done before you call.",
  means: "A warm market means senior engineers are already read and in conversation when a role opens.",
  getsYou: "Your first answer is about fit, not about finding people, so it arrives inside the window.",
  demo: "Three line drawings that draw themselves: a stack read before you call, two-way arrows for people in conversation, a prefix tree shared per company.",
  buildStep: 4,
  facts: [
    { title: "Read before your brief arrives.", body: "Senior engineers are read before a role opens, so the first pass is already done." },
    { title: "In conversation, not cold.", body: "The people we send are already talking to us, not found the week you called." },
    { title: "Shared prefix per company.", body: "Everything we learn about your team carries to the next role." },
  ],
  cta: CTA.bookCall,
};

export const TTFT: Section = {
  id: "time-to-first-profile",
  eyebrow: "time to first token",
  heading: "Time to first profile.",
  sub: "The clock from your brief landing to the first profile in your inbox, or to a written market read.",
  means: "Time to first token is time to first profile, reported as a median across closed roles, not as a promise.",
  getsYou: "You know inside the first window whether the role is fillable as written, and what to loosen if not.",
  demo: "A ticker of the roles we place, a request timeline for two roles at one company, and a curve of time to first profile that reads measuring until the data exists.",
  buildStep: 4,
  facts: [
    { title: "A profile or a market read.", body: "The read says where the people are, what they cost, and what to loosen." },
    { title: "Reported, not promised.", body: "Median and p90 measured from closed roles, updated as roles close." },
    { title: "Senior AI and software roles.", body: "From founding engineer to engineering manager." },
  ],
  cta: CTA.sendBrief,
};

export const COVERAGE = [
  "Inference", "Training infra", "Distributed systems", "Applied ML", "Platform",
  "Data", "Backend", "Founding engineer", "Staff", "Engineering manager",
];

export const CUSTOMERS: Section = {
  id: "customers",
  eyebrow: "customers",
  heading: "What hiring managers say.",
  sub: "",
  means: "",
  getsYou: "",
  demo: "Two quotes already published on the About page, and three open roles.",
  buildStep: 4,
  facts: [],
  cta: CTA.viewRoles,
};

export const OPEN_NOW_DEMO = "Open now: three roles from the board.";

export const QUOTES = [
  { text: "Five key hires over the last two years. We now only work with Transformer Talent.", who: "CTO, Series B fintech" },
  { text: "The only recruiters we've used who actually understood the role before sending profiles.", who: "Founder, Applied AI, seed" },
];

const PRICING_FACTS: Fact[] = [{ title: "Pay on hire.", body: "One fee, at start date." }];
if (PRICING_CONFIRMED) {
  PRICING_FACTS.push(
    { title: "No retainer.", body: "Nothing is billed to open a search." },
    { title: "Nothing billed between roles.", body: "A quiet quarter costs nothing." },
  );
}

export const SCALE_TO_ZERO: Section = {
  id: "pay-on-hire",
  eyebrow: "scale to zero",
  heading: "Pay on hire.",
  sub: "One fee, when someone you chose starts.",
  means: "Scale to zero means nothing bills when nothing is running. For us that is one fee, at start date.",
  getsYou: "The cost of trying us is one call and one brief.",
  demo: "A cost line, flat at zero across the weeks a role is open, with one step up at start date.",
  buildStep: 4,
  facts: PRICING_FACTS,
  cta: CTA.sendBrief,
  tone: "light",
};

export const SECTIONS: Section[] = [KV_CACHE, TOP_K, ATTENTION, MARKET, TTFT, CUSTOMERS, SCALE_TO_ZERO];

export const FOOTER = {
  columns: [
    { title: "For hiring managers", links: [{ label: "Send a brief", href: "/talent" }, { label: "Book a call", href: CONTACT_HREF }] },
    { title: "For engineers", links: [{ label: "Open roles", href: "/roles" }, { label: "Send a resume", href: "/apply?speculative=1" }] },
    { title: "Roles", links: [{ label: "All roles", href: "/roles" }, { label: "Market index", href: "/market-index" }] },
    { title: "About", links: [{ label: "How we work", href: "/about" }] },
    { title: "Contact", links: [{ label: "spencer@transformertalent.com", href: "mailto:spencer@transformertalent.com" }] },
  ],
  line: "Transformer Talent. Founded by a former software engineer.",
};

export const LABELS = {
  means: "means",
  getsYou: "you get",
  demoPending: "demo",
  sample: "sample",
  mainNav: "Main",
  recentPlacements: "Recent placements",
  stages: "Stages of the search",
};
