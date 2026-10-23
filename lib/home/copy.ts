// Every string on the homepage. The page is one request through the
// serving stack, in order: cold start, prefill, kv cache, decode, sampling,
// stream, stop token. Each stage says only what happens in the search at
// that stage, in the stage's own verbs. The reader serves models for a
// living, so no stage is ever defined. Wording per Spencer, 2026-10-23.
// No em-dashes. No internal tooling. Numbers come from lib/home/placeholders.
import { numberWord, SHORTLIST_SIZE } from "./placeholders";

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
};

export const HERO = {
  headlineBefore: "The ",
  headlineAccent: "inference layer",
  headlineAfter: " for hiring.",
  sub: "Talent infrastructure for teams that develop, train, and serve.",
  stageAria:
    "One request end to end: cold start already paid, the brief loaded at prefill, held in the cache, candidates decoded and sampled, streamed as they clear, and the stop token at a signed offer.",
  footnote: "Timing illustrative until measured from role data.",
};

export const PROOF = {
  lead: "Placements at companies backed by",
  investors: ["Sequoia", "8VC", "Felicis", "Y Combinator", "a16z"],
};

export type Fact = { title: string; body: string };
export type Stage = {
  id: string;
  name: string;
  heading: string;
  sub: string;
  demo: string;
  buildStep: number;
  facts: Fact[];
  cta: { label: string; href: string };
};

const K = numberWord(SHORTLIST_SIZE);

export const STAGES: Stage[] = [
  {
    id: "cold-start",
    name: "cold start, already paid",
    heading: "Your search starts warm.",
    sub: "We're already mapping the market and talking to engineers before your request arrives.",
    demo: "Three line drawings that draw themselves: the market mapped before you call, two-way arrows for engineers in conversation, a prefix tree shared per company.",
    buildStep: 4,
    facts: [
      { title: "Mapped before you call.", body: "The market is read before a role opens, so the first pass is already done." },
      { title: "In conversation, not cold.", body: "The engineers we send are already talking to us, not found the week you called." },
      { title: "Senior AI and software roles.", body: "From founding engineer to engineering manager." },
    ],
    cta: CTA.bookCall,
  },
  {
    id: "prefill",
    name: "prefill",
    heading: "At kickoff, we load the full brief.",
    sub: "Team, hiring bar, compensation, and lessons from your last hire.",
    demo: "The brief is typed once in your words and the field lights where it lands; each finished line becomes a cell in the cache.",
    buildStep: 7,
    facts: [
      { title: "Loaded once.", body: "Team, hiring bar, compensation and the lessons from your last hire, held for the whole search." },
      { title: "One kickoff.", body: "The brief is loaded there and not asked for again." },
      { title: "Your words.", body: "The brief is held as you gave it, not rewritten into a job title." },
    ],
    cta: CTA.sendBrief,
  },
  {
    id: "kv-cache",
    name: "kv cache",
    heading: "Your brief and feedback stay cached throughout the search.",
    sub: "Shared company context gives the next role a warm start.",
    demo: "A cache strip that grows as reviews are appended, then a second lane for role two with the shared cells already lit. Readout: evicted 0.",
    buildStep: 8,
    facts: [
      { title: "Feedback appended.", body: "Pass or progress, with your reason, is written into the search the moment you send it." },
      { title: "Nothing evicted while the role is open.", body: "We do not forget what senior means to you between batches." },
      { title: "Warm start on role two.", body: "Shared company context means the next brief only needs what differs." },
    ],
    cta: CTA.sendBrief,
  },
  {
    id: "decode",
    name: "decode",
    heading: "We evaluate candidates against the full context.",
    sub: "Returning a reasoned match, or a market read when no one fits.",
    demo: "Hover a phrase from the sample brief and the field rises where it matters; hover a candidate and the lines behind the match brighten. A thin market returns a market read instead of a name.",
    buildStep: 9,
    facts: [
      { title: "Against the full context.", body: "Every candidate is evaluated against the brief and every review so far." },
      { title: "A reasoned match.", body: "Why them, why now, and what to check first, with every profile." },
      { title: "A market read when no one fits.", body: "Where the people are, what they cost, and what to loosen. Never a name to fill the slot." },
    ],
    cta: CTA.sendBrief,
  },
  {
    id: "sampling",
    name: "sampling",
    heading: `Top-k is ${K.toLowerCase()}.`,
    sub: "You set the temperature for how far beyond the spec we explore.",
    demo: `${K} candidates rise above a line labelled held back, each with its reason; the rest stay below the cut.`,
    buildStep: 9,
    facts: [
      { title: "The top of the distribution.", body: "You see the top, not the whole distribution." },
      { title: "You set the temperature.", body: "How far beyond the spec we explore is your call." },
      { title: "Below the cut stays below the cut.", body: "Everything else is held back, not forwarded." },
    ],
    cta: CTA.sendBrief,
  },
  {
    id: "stream",
    name: "stream",
    heading: "Candidates are presented to you as they clear review.",
    sub: "Each with a profile and the brief-linked evidence behind their fit.",
    demo: "A ticker of the roles we place, a request timeline for two roles at one company, and a curve of time to first profile that reads measuring until the data exists.",
    buildStep: 4,
    facts: [
      { title: "As they clear review.", body: "Candidates arrive one at a time, not in a Friday batch." },
      { title: "Brief-linked evidence.", body: "Each profile carries the lines of your brief behind the fit." },
      { title: "Time to first profile: measuring.", body: "Median and p90 will be reported from closed roles once enough have closed." },
    ],
    cta: CTA.sendBrief,
  },
  {
    id: "stop-token",
    name: "stop token",
    heading: "The request completes when your chosen candidate signs the offer.",
    sub: "Then what completed searches say.",
    demo: "Two quotes already published on the About page, and three open roles.",
    buildStep: 4,
    facts: [],
    cta: CTA.viewRoles,
  },
];

export const OPEN_NOW_DEMO = "Open now: three roles from the board.";

export const COVERAGE = [
  "Inference", "Training infra", "Distributed systems", "Applied ML", "Platform",
  "Data", "Backend", "Founding engineer", "Staff", "Engineering manager",
];

export const QUOTES = [
  { text: "Five key hires over the last two years. We now only work with Transformer Talent.", who: "CTO, Series B fintech" },
  { text: "The only recruiters we've used who actually understood the role before sending profiles.", who: "Founder, Applied AI, seed" },
];

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
  demoPending: "demo",
  sample: "sample",
  mainNav: "Main",
  recentPlacements: "Recent placements",
  trace: "Request trace",
  stageOf: "of",
};
