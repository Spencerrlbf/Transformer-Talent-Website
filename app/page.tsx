import type { Metadata } from "next";
import Link from "next/link";
import { Inter, DM_Mono } from "next/font/google";
import CacheStage from "@/components/home/CacheStage";
import "./home.css";

// The inference-layer homepage (mock A in Recruitment-Matching/mocks/
// inference-layer). One idea on the page: we hold your context. Numbers in
// the stats row are placeholders until measured from role data; the fine
// print under them says so and must stay until they are.

const ilSans = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-il-sans" });
const ilMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-il-mono" });

const CONTACT = "mailto:spencer@transformertalent.com?subject=Brief";

export const metadata: Metadata = {
  title: { absolute: "Transformer Talent, the inference layer for hiring" },
  description:
    "Brief us once. We hold the context. Engineering search for teams that run inference: the market is prefilled, every profile ships with its reason, and nothing you tell us is evicted.",
};

const GLOSSARY: [string, string][] = [
  ["time to first token", "Time to first answer. A profile or a market read, whichever is true."],
  ["prefill", "Already done on the market side. Your brief is the only cold input."],
  ["confidence", "When the market is thin we say so, instead of sending a name."],
  ["throughput", "Qualified profiles per week. Not applicants per week."],
  ["top-k", "The shortlist. You see the top of the distribution, not the distribution."],
  ["temperature", "How far from the exact spec we're allowed to look. You set it."],
  ["speculative decoding", "A fast draft list, verified by a senior recruiter before you see it."],
  ["reasoning trace", "Every profile ships with why."],
  ["positional encoding", "Where someone sits in their tenure tells us when they'll move."],
  ["stop token", "Generation ends at a signed offer."],
  ["scale to zero", "No retainer. Nothing billed between roles."],
  ["evals", "Interview rate and offer rate, published."],
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="il-eyebrow"><i />{children}</div>;
}

export default function Home() {
  return (
    <main className={`il-home ${ilSans.variable} ${ilMono.variable}`}>
      <div className="il-wrap">
        <nav className="il-nav" aria-label="Main">
          <Link className="il-brand" href="/"><b />Transformer Talent</Link>
          <div className="il-links">
            <Link href="/talent">For hiring managers</Link>
            <Link href="/roles">For engineers</Link>
            <a href="#memory">How it works</a>
            <Link href="/about">About</Link>
          </div>
          <div className="il-navright">
            <Link className="il-pill ghost" href="/dashboard">Log in</Link>
            <a className="il-pill primary" href={CONTACT}>Book a call</a>
          </div>
        </nav>

        <section className="il-hero">
          <Eyebrow>The inference layer for hiring</Eyebrow>
          <h1 className="il-h1">Brief us once.<br />We hold the <em>context</em>.</h1>
          <p className="il-hero-sub">
            The engineering market is already read, indexed and engaged before your brief arrives. Your brief is the only cold part.
          </p>
          <div className="il-ctas">
            <a className="il-pill primary" href={CONTACT}>Book a call</a>
            <a className="il-pill ghost" href="#memory">How the cache works</a>
          </div>

          <CacheStage />

          <div className="il-stats">
            <div><b>36h</b><span>Median time to first answer, across live roles</span></div>
            <div><b>1</b><span>Profile, or an honest market read. Never a name to fill the gap.</span></div>
            <div><b>5</b><span>Profiles per shortlist, each with the reason written down</span></div>
            <div><b>0</b><span>Retainer. Nothing billed between roles.</span></div>
          </div>
          <div className="il-fine">median is illustrative until measured from role data. reported, not promised.</div>
        </section>

        <section className="il-section">
          <Eyebrow>First answer</Eyebrow>
          <h2 className="il-h2">A profile, or the truth about the market.</h2>
          <p className="il-lede">
            A model that emits a token when it has nothing to say is hallucinating. We don&apos;t. Inside the first window you get one of two things.
          </p>
          <div className="il-panels">
            <div className="il-panel">
              <h3><i />A profile</h3>
              <p>An engineer we would hire ourselves, with the reason attached. Why them, why now, and what to check in the first conversation.</p>
            </div>
            <div className="il-panel">
              <h3><i />A market read</h3>
              <p>How many people fit, where they sit, what they cost, and which part of the spec to loosen if you want more of them. An answer, not a name.</p>
            </div>
          </div>
        </section>

        <section className="il-section">
          <div className="il-split">
            <div>
              <Eyebrow>What we are</Eyebrow>
              <h2 className="il-h2">The layer between the market and your headcount.</h2>
            </div>
            <p className="il-lede">
              Somebody has to do the expensive part of hiring: read the brief properly, hold it in memory, and run every candidate against it. Most agencies do that work once and then forget it. We treat it as inference. The brief is the prompt. The shortlist is the output. Most of the work in between is done before you call, because the market side is already prefilled. The only thing we have to warm up is you.
            </p>
          </div>
        </section>

        <section className="il-section" id="memory">
          <Eyebrow>Memory</Eyebrow>
          <h2 className="il-h2">Your context, cached.</h2>
          <p className="il-lede">
            A search gets better the longer it runs, because nothing you tell us is thrown away. It works the way a transformer serves a long conversation.
          </p>
          <div className="il-steps">
            <div><h3>01 prefill</h3><strong>One kickoff call.</strong><p>We read the whole brief: the team, the bar, the compensation, why the last hire didn&apos;t work. The expensive pass, done once.</p></div>
            <div><h3>02 decode</h3><strong>Every profile after that.</strong><p>Scored against the cached brief. We never re-read it. You never re-explain it.</p></div>
            <div><h3>03 append</h3><strong>Every review you give.</strong><p>Pass or progress, with a reason, written back into the cache. The next profile knows what the last one taught us.</p></div>
            <div><h3>04 warm start</h3><strong>Your second role.</strong><p>Shares the prefix. It starts with everything we already know about how you hire.</p></div>
          </div>
          <div className="il-cache" aria-label="One open role's cache">
            <span className="m">market</span><span className="f">brief</span><span className="f">team</span><span className="f">bar</span><span className="f">comp</span><span className="f">pass: too junior</span><span className="f">progress: ex-infra</span><span className="f">pass: notice</span><span className="n">next profile</span>
          </div>
          <p className="il-note">The first cell is already there when you arrive. Nothing is evicted while the role is open. We don&apos;t forget what &quot;senior&quot; means to you between batches.</p>
        </section>

        <section className="il-section">
          <Eyebrow>Glossary</Eyebrow>
          <h2 className="il-h2">If you run inference, you already know how we work.</h2>
          <div className="il-gloss">
            {GLOSSARY.map(([term, meaning]) => (
              <div key={term}><span>{term}</span>{meaning}</div>
            ))}
          </div>
        </section>
      </div>

      <div className="il-band">
        <div className="il-wrap">
          <h2 className="il-h2">Send us one brief.</h2>
          <p>Thirty minutes to prefill. A first answer inside the window above, and we tell you which kind it is. Pay on hire.</p>
          <a className="il-pill primary" href={CONTACT}>Book a call</a>
        </div>
      </div>

      <div className="il-wrap">
        <footer className="il-foot">
          <div>Transformer Talent. Founded by a former software engineer.</div>
          <a href="mailto:spencer@transformertalent.com">spencer@transformertalent.com</a>
        </footer>
      </div>
    </main>
  );
}
