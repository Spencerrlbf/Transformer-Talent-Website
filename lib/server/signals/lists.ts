// The top-university and top-employer lists the person signals read. Drafted
// for Spencer on 2026-09-23 and kept in step with the Claude Docs doc
// "Signal lists: top universities and employers"; edit the doc, then this.
// Tier 1 is the short list a hiring manager reads as elite; tier 2 is
// strong. The aliases are the other ways a profile writes the same name.
//
// Employers come from two places: the hand list below, and the Paraform
// grades in paraform-employers.json (scripts/import-paraform-grades.mjs),
// where S and A are tier 1 and B and C tier 2. TOP_EMPLOYERS merges them: a
// graded company already on the hand list moves up when its grade says so
// and never moves down; a graded subsidiary listed as an alias becomes its
// own entry when its grade beats its parent's.
import paraform from "./paraform-employers.json";
export interface ListEntry {
  name: string;
  aliases?: string[];
  tier: 1 | 2;
}

export const TOP_UNIVERSITIES: ListEntry[] = [
  { name: "Massachusetts Institute of Technology", aliases: ["MIT"], tier: 1 },
  { name: "Stanford University", aliases: ["Stanford"], tier: 1 },
  { name: "Carnegie Mellon University", aliases: ["CMU", "Carnegie Mellon"], tier: 1 },
  { name: "University of California, Berkeley", aliases: ["UC Berkeley", "Berkeley"], tier: 1 },
  { name: "California Institute of Technology", aliases: ["Caltech"], tier: 1 },
  { name: "Harvard University", aliases: ["Harvard"], tier: 1 },
  { name: "Princeton University", aliases: ["Princeton"], tier: 1 },
  { name: "University of Illinois Urbana-Champaign", aliases: ["UIUC", "University of Illinois at Urbana-Champaign", "University of Illinois Urbana Champaign"], tier: 1 },
  { name: "Georgia Institute of Technology", aliases: ["Georgia Tech"], tier: 1 },
  { name: "University of Washington", aliases: ["UW"], tier: 1 },
  { name: "Cornell University", aliases: ["Cornell"], tier: 1 },
  { name: "University of Michigan", aliases: ["Michigan, Ann Arbor", "University of Michigan-Ann Arbor", "University of Michigan - Ann Arbor"], tier: 1 },
  { name: "University of Texas at Austin", aliases: ["UT Austin", "The University of Texas at Austin"], tier: 1 },
  { name: "Columbia University", aliases: ["Columbia University in the City of New York"], tier: 1 },
  { name: "University of Pennsylvania", aliases: ["UPenn", "Penn"], tier: 1 },
  { name: "Yale University", aliases: ["Yale"], tier: 1 },
  { name: "University of Cambridge", aliases: ["Cambridge University"], tier: 1 },
  { name: "University of Oxford", aliases: ["Oxford University"], tier: 1 },
  { name: "Imperial College London", aliases: ["Imperial College"], tier: 1 },
  { name: "ETH Zurich", aliases: ["ETH Zürich", "Swiss Federal Institute of Technology", "ETH"], tier: 1 },
  { name: "EPFL", aliases: ["École Polytechnique Fédérale de Lausanne", "Ecole Polytechnique Federale de Lausanne"], tier: 1 },
  { name: "University of Toronto", aliases: ["U of T"], tier: 1 },
  { name: "University of Waterloo", aliases: ["Waterloo"], tier: 1 },
  { name: "Indian Institute of Technology", aliases: ["IIT Bombay", "IIT Delhi", "IIT Madras", "IIT Kanpur", "IIT Kharagpur", "IIT Roorkee", "IIT Guwahati", "IIT Hyderabad", "IIT"], tier: 1 },
  { name: "Indian Institute of Science", aliases: ["IISc", "IISc Bangalore"], tier: 1 },
  { name: "Tsinghua University", aliases: ["Tsinghua"], tier: 1 },
  { name: "Peking University", aliases: ["PKU"], tier: 1 },
  { name: "National University of Singapore", aliases: ["NUS"], tier: 1 },
  { name: "Technion", aliases: ["Technion - Israel Institute of Technology", "Israel Institute of Technology"], tier: 1 },
  { name: "Tel Aviv University", aliases: ["TAU"], tier: 1 },
  { name: "University of California, Los Angeles", aliases: ["UCLA"], tier: 2 },
  { name: "University of California, San Diego", aliases: ["UCSD", "UC San Diego"], tier: 2 },
  { name: "University of California, Irvine", aliases: ["UCI", "UC Irvine"], tier: 2 },
  { name: "University of California, Davis", aliases: ["UC Davis"], tier: 2 },
  { name: "University of California, Santa Barbara", aliases: ["UCSB", "UC Santa Barbara"], tier: 2 },
  { name: "University of Wisconsin-Madison", aliases: ["UW-Madison", "University of Wisconsin Madison"], tier: 2 },
  { name: "Purdue University", aliases: ["Purdue"], tier: 2 },
  { name: "University of Maryland, College Park", aliases: ["UMD", "University of Maryland"], tier: 2 },
  { name: "University of Southern California", aliases: ["USC"], tier: 2 },
  { name: "New York University", aliases: ["NYU"], tier: 2 },
  { name: "University of Chicago", aliases: ["UChicago"], tier: 2 },
  { name: "Northwestern University", aliases: ["Northwestern"], tier: 2 },
  { name: "Duke University", aliases: ["Duke"], tier: 2 },
  { name: "Brown University", aliases: ["Brown"], tier: 2 },
  { name: "Johns Hopkins University", aliases: ["JHU", "Johns Hopkins"], tier: 2 },
  { name: "Rice University", aliases: ["Rice"], tier: 2 },
  { name: "Dartmouth College", aliases: ["Dartmouth"], tier: 2 },
  { name: "University of Massachusetts Amherst", aliases: ["UMass Amherst"], tier: 2 },
  { name: "University of Minnesota", aliases: ["University of Minnesota-Twin Cities"], tier: 2 },
  { name: "Ohio State University", aliases: ["The Ohio State University"], tier: 2 },
  { name: "Pennsylvania State University", aliases: ["Penn State", "Penn State University"], tier: 2 },
  { name: "Virginia Tech", aliases: ["Virginia Polytechnic Institute and State University"], tier: 2 },
  { name: "University of Virginia", aliases: ["UVA"], tier: 2 },
  { name: "University of North Carolina at Chapel Hill", aliases: ["UNC Chapel Hill", "UNC"], tier: 2 },
  { name: "Northeastern University", aliases: ["Northeastern"], tier: 2 },
  { name: "Boston University", aliases: ["BU"], tier: 2 },
  { name: "Texas A&M University", aliases: ["Texas A&M"], tier: 2 },
  { name: "Harvey Mudd College", aliases: ["Harvey Mudd"], tier: 2 },
  { name: "University of British Columbia", aliases: ["UBC"], tier: 2 },
  { name: "McGill University", aliases: ["McGill"], tier: 2 },
  { name: "University College London", aliases: ["UCL"], tier: 2 },
  { name: "University of Edinburgh", aliases: ["The University of Edinburgh"], tier: 2 },
  { name: "King's College London", aliases: ["KCL"], tier: 2 },
  { name: "University of Manchester", aliases: ["The University of Manchester"], tier: 2 },
  { name: "University of Bristol", tier: 2 },
  { name: "University of Warwick", tier: 2 },
  { name: "Trinity College Dublin", aliases: ["TCD"], tier: 2 },
  { name: "Technical University of Munich", aliases: ["TUM", "TU München", "TU Munchen", "Technische Universität München"], tier: 2 },
  { name: "RWTH Aachen University", aliases: ["RWTH Aachen"], tier: 2 },
  { name: "KTH Royal Institute of Technology", aliases: ["KTH"], tier: 2 },
  { name: "Delft University of Technology", aliases: ["TU Delft"], tier: 2 },
  { name: "University of Amsterdam", aliases: ["UvA"], tier: 2 },
  { name: "Aalto University", aliases: ["Aalto"], tier: 2 },
  { name: "École Polytechnique", aliases: ["Ecole Polytechnique"], tier: 2 },
  { name: "Sorbonne University", aliases: ["Sorbonne Université", "Sorbonne"], tier: 2 },
  { name: "Politecnico di Milano", aliases: ["Polimi"], tier: 2 },
  { name: "Hebrew University of Jerusalem", aliases: ["Hebrew University"], tier: 2 },
  { name: "Shanghai Jiao Tong University", aliases: ["SJTU"], tier: 2 },
  { name: "Zhejiang University", aliases: ["ZJU"], tier: 2 },
  { name: "Fudan University", aliases: ["Fudan"], tier: 2 },
  { name: "Nanyang Technological University", aliases: ["NTU Singapore", "NTU"], tier: 2 },
  { name: "KAIST", aliases: ["Korea Advanced Institute of Science and Technology"], tier: 2 },
  { name: "Seoul National University", aliases: ["SNU"], tier: 2 },
  { name: "University of Tokyo", aliases: ["The University of Tokyo", "Todai"], tier: 2 },
  { name: "Kyoto University", tier: 2 },
  { name: "University of Melbourne", aliases: ["The University of Melbourne"], tier: 2 },
  { name: "University of Sydney", aliases: ["The University of Sydney"], tier: 2 },
  { name: "Australian National University", aliases: ["ANU"], tier: 2 },
  { name: "University of New South Wales", aliases: ["UNSW"], tier: 2 },
];

export const HAND_EMPLOYERS: ListEntry[] = [
  { name: "Meta", aliases: ["Meta Platforms", "Facebook", "Instagram", "WhatsApp", "Oculus"], tier: 1 },
  { name: "Google", aliases: ["Alphabet", "Google DeepMind", "DeepMind", "YouTube", "Waymo", "Verily", "Google Research"], tier: 1 },
  { name: "Apple", tier: 1 },
  { name: "Amazon", aliases: ["Amazon Web Services", "AWS"], tier: 1 },
  { name: "Microsoft", aliases: ["GitHub", "LinkedIn", "Microsoft Research"], tier: 1 },
  { name: "Netflix", tier: 1 },
  { name: "NVIDIA", aliases: ["Nvidia"], tier: 1 },
  { name: "OpenAI", tier: 1 },
  { name: "Anthropic", tier: 1 },
  { name: "Stripe", tier: 1 },
  { name: "Airbnb", tier: 1 },
  { name: "Uber", aliases: ["Uber Technologies"], tier: 1 },
  { name: "Databricks", tier: 1 },
  { name: "Snowflake", tier: 1 },
  { name: "Palantir", aliases: ["Palantir Technologies"], tier: 1 },
  { name: "Tesla", tier: 1 },
  { name: "SpaceX", tier: 1 },
  { name: "Jane Street", aliases: ["Jane Street Capital"], tier: 1 },
  { name: "Two Sigma", aliases: ["Two Sigma Investments"], tier: 1 },
  { name: "Citadel", aliases: ["Citadel Securities", "Citadel LLC"], tier: 1 },
  { name: "Hudson River Trading", aliases: ["HRT"], tier: 1 },
  { name: "Jump Trading", tier: 1 },
  { name: "D. E. Shaw", aliases: ["D.E. Shaw", "DE Shaw", "D. E. Shaw & Co.", "The D. E. Shaw Group"], tier: 1 },
  { name: "Scale AI", tier: 1 },
  { name: "Figma", tier: 1 },
  { name: "Cloudflare", tier: 1 },
  { name: "Datadog", tier: 1 },
  { name: "Adobe", tier: 2 },
  { name: "Salesforce", aliases: ["Slack", "Tableau"], tier: 2 },
  { name: "Oracle", tier: 2 },
  { name: "Intel", aliases: ["Intel Corporation"], tier: 2 },
  { name: "AMD", aliases: ["Advanced Micro Devices"], tier: 2 },
  { name: "Qualcomm", tier: 2 },
  { name: "Arm", aliases: ["Arm Holdings"], tier: 2 },
  { name: "Cisco", aliases: ["Cisco Systems"], tier: 2 },
  { name: "IBM", aliases: ["IBM Research"], tier: 2 },
  { name: "Samsung Research", aliases: ["Samsung Electronics"], tier: 2 },
  { name: "Bloomberg", aliases: ["Bloomberg LP"], tier: 2 },
  { name: "Goldman Sachs", tier: 2 },
  { name: "JPMorgan Chase", aliases: ["JPMorgan", "J.P. Morgan", "JPMorgan Chase & Co."], tier: 2 },
  { name: "Morgan Stanley", tier: 2 },
  { name: "Capital One", tier: 2 },
  { name: "Block", aliases: ["Square", "Cash App"], tier: 2 },
  { name: "Coinbase", tier: 2 },
  { name: "Robinhood", tier: 2 },
  { name: "Plaid", tier: 2 },
  { name: "Brex", tier: 2 },
  { name: "Ramp", tier: 2 },
  { name: "Affirm", tier: 2 },
  { name: "Shopify", tier: 2 },
  { name: "Atlassian", tier: 2 },
  { name: "Canva", tier: 2 },
  { name: "Dropbox", tier: 2 },
  { name: "Pinterest", tier: 2 },
  { name: "Snap", aliases: ["Snapchat", "Snap Inc"], tier: 2 },
  { name: "Reddit", tier: 2 },
  { name: "Discord", tier: 2 },
  { name: "X", aliases: ["Twitter", "X Corp"], tier: 2 },
  { name: "Spotify", tier: 2 },
  { name: "Zoom", aliases: ["Zoom Video Communications"], tier: 2 },
  { name: "Twilio", tier: 2 },
  { name: "MongoDB", tier: 2 },
  { name: "HashiCorp", tier: 2 },
  { name: "Confluent", tier: 2 },
  { name: "Elastic", tier: 2 },
  { name: "Notion", aliases: ["Notion Labs"], tier: 2 },
  { name: "Rippling", tier: 2 },
  { name: "Gusto", tier: 2 },
  { name: "Retool", tier: 2 },
  { name: "Vercel", tier: 2 },
  { name: "Supabase", tier: 2 },
  { name: "DoorDash", tier: 2 },
  { name: "Instacart", tier: 2 },
  { name: "Lyft", tier: 2 },
  { name: "Cruise", tier: 2 },
  { name: "Rivian", tier: 2 },
  { name: "Anduril", aliases: ["Anduril Industries"], tier: 2 },
  { name: "Roblox", tier: 2 },
  { name: "Unity", aliases: ["Unity Technologies"], tier: 2 },
  { name: "Epic Games", tier: 2 },
  { name: "ByteDance", aliases: ["TikTok"], tier: 2 },
  { name: "Tencent", tier: 2 },
  { name: "Alibaba", aliases: ["Alibaba Group", "Alibaba Cloud"], tier: 2 },
  { name: "Baidu", tier: 2 },
  { name: "Grab", tier: 2 },
  { name: "Booking.com", aliases: ["Booking Holdings"], tier: 2 },
  { name: "Revolut", tier: 2 },
  { name: "Monzo", aliases: ["Monzo Bank"], tier: 2 },
  { name: "Wise", aliases: ["TransferWise"], tier: 2 },
  { name: "Nubank", tier: 2 },
  { name: "Mistral AI", aliases: ["Mistral"], tier: 2 },
  { name: "Cohere", tier: 2 },
  { name: "Hugging Face", tier: 2 },
  { name: "xAI", tier: 2 },
  { name: "Perplexity", aliases: ["Perplexity AI"], tier: 2 },
  { name: "Anysphere", aliases: ["Cursor"], tier: 2 },
];

interface GradedCompany {
  name: string;
  grade: "S" | "A" | "B" | "C";
  tier: 1 | 2;
  people: number;
}

/** A loose key for telling two spellings of one company apart. */
const key = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|plc|gmbh|pvt|pte|nv|bv|co)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");

/** A hand entry changes tier only when this many graded people back the
 *  grade; a new company is added at its grade however few people carry it. */
export const MIN_PEOPLE_TO_MOVE = 3;

/** The hand list merged with the Paraform grades. */
export function mergeEmployers(hand: ListEntry[], graded: GradedCompany[]): ListEntry[] {
  const out: ListEntry[] = hand.map((e) => ({ ...e, aliases: e.aliases ? [...e.aliases] : undefined }));
  const byName = new Map<string, ListEntry>();
  const byAlias = new Map<string, ListEntry>();
  for (const e of out) {
    byName.set(key(e.name), e);
    for (const a of e.aliases || []) byAlias.set(key(a), e);
  }
  const gradeOf = new Map(graded.map((g) => [key(g.name), g] as const));
  for (const g of graded) {
    const k = key(g.name);
    if (!k) continue;
    const own = byName.get(k);
    if (own) {
      if (g.tier < own.tier && g.people >= MIN_PEOPLE_TO_MOVE) own.tier = g.tier;
      continue;
    }
    const parent = byAlias.get(k);
    if (parent) {
      const parentGrade = gradeOf.get(key(parent.name));
      if (g.tier >= parent.tier || g.people < MIN_PEOPLE_TO_MOVE) continue;
      if (parentGrade && parentGrade.tier > g.tier) {
        // "Slack" graded above "Salesforce": Slack stands on its own.
        parent.aliases = (parent.aliases || []).filter((a) => key(a) !== k);
        const entry: ListEntry = { name: g.name, tier: g.tier };
        out.push(entry);
        byName.set(k, entry);
      } else {
        parent.tier = g.tier;
      }
      continue;
    }
    const entry: ListEntry = { name: g.name, tier: g.tier };
    out.push(entry);
    byName.set(k, entry);
  }
  return out;
}

export const TOP_EMPLOYERS: ListEntry[] = mergeEmployers(HAND_EMPLOYERS, paraform.companies as GradedCompany[]);

/** Changes with either list, so stored signals are recomputed after an edit. */
export const LISTS_VERSION: string = (() => {
  const text = JSON.stringify([TOP_UNIVERSITIES, TOP_EMPLOYERS]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16).padStart(8, "0");
})();
