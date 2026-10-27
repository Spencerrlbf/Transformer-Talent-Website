import type { Metadata } from "next";
import Link from "next/link";
import { Inter, DM_Mono } from "next/font/google";
import StageSection, { DemoSlot } from "@/components/home/Section";
import RequestTimeline from "@/components/home/RequestTimeline";
import MarketCards from "@/components/home/MarketCards";
import StreamPanel from "@/components/home/StreamPanel";
import OpenNow from "@/components/home/OpenNow";
import { PLACEMENTS } from "@/data/placements";
import { CTA, FOOTER, HERO, LABELS, NAV, PROOF, QUOTES, STAGES } from "@/lib/home/copy";
import "./home.css";

// The inference-layer homepage: one request through the serving stack, with
// the search as the content of each stage. Plan: Recruitment-Matching/mocks/
// inference-layer/plan-v2.md (stage wording per Spencer, 2026-10-23). The
// hero carries the static request timeline (build step 3); the static demos
// of step 4 sit in the cold start, stream and stop token stages, and the
// other stages still show a pending panel in their demo slots. Every string
// is in lib/home/copy.ts, every number in lib/home/placeholders.ts.

// Open now reads the board through getRoles(), which may fetch live data when
// configured; re-render the page at most once an hour.
export const revalidate = 3600;

const ilSans = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-il-sans" });
const ilMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-il-mono" });

export const metadata: Metadata = {
  title: { absolute: "Transformer Talent, the inference layer for hiring" },
  description: HERO.sub,
};

function Pill({ label, href, primary }: { label: string; href: string; primary?: boolean }) {
  const cls = `il-pill ${primary ? "primary" : "ghost"}`;
  return href.startsWith("mailto:") ? (
    <a className={cls} href={href}>{label}</a>
  ) : (
    <Link className={cls} href={href}>{label}</Link>
  );
}

const STOP = STAGES[STAGES.length - 1];

// The demo for a stage, by stage id. Stages without one fall back to the
// pending panel inside StageSection. The demos render in a plain .il-demo
// frame rather than DemoSlot: DemoSlot marks its wrapper role="img", which
// would hide the demos' real text and links from assistive tech, and every
// SVG already names itself through Diagram.
function demoFor(id: string): React.ReactNode {
  switch (id) {
    case "cold-start":
      return <div className="il-demo"><MarketCards /></div>;
    case "stream":
      return <div className="il-demo"><StreamPanel /></div>;
    default:
      return undefined;
  }
}

export default function Home() {
  return (
    <div className={`il-home ${ilSans.variable} ${ilMono.variable}`}>
      <header className="il-wrap">
        <nav className="il-nav" aria-label={LABELS.mainNav}>
          <Link className="il-brand" href="/"><b aria-hidden="true" />{NAV.brand}</Link>
          <div className="il-links">
            {NAV.links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
          </div>
          <div className="il-navright">
            <Pill label={NAV.login.label} href={NAV.login.href} />
            <Pill label={NAV.cta.label} href={NAV.cta.href} primary />
          </div>
        </nav>
      </header>

      <main>
        <section className="il-hero" aria-labelledby="hero-h">
          <div className="il-wrap">
            <h1 className="il-h1" id="hero-h">
              {HERO.headlineBefore}<em>{HERO.headlineAccent}</em>{HERO.headlineAfter}
            </h1>
            <p className="il-hero-sub">{HERO.sub}</p>
            <div className="il-ctas">
              <Pill label={CTA.sendBrief.label} href={CTA.sendBrief.href} primary />
              <Pill label={CTA.bookCall.label} href={CTA.bookCall.href} />
            </div>
            <DemoSlot description={HERO.stageAria} className="il-stage">
              <RequestTimeline />
            </DemoSlot>
            <ol className="il-tl-legend" aria-label={HERO.timeline.title}>
              {STAGES.map((s) => <li key={s.id}>{s.name}</li>)}
            </ol>
            <p className="il-footnote">{HERO.footnote}</p>
            <div className="il-proof">
              <span className="il-proof-lead">{PROOF.lead}</span>
              <ul className="il-investors">
                {PROOF.investors.map((v) => <li key={v}>{v}</li>)}
              </ul>
            </div>
            <ul className="il-placed" aria-label={LABELS.recentPlacements}>
              {PLACEMENTS.map((p) => (
                <li key={p.company}>
                  <span className="il-placed-role">{p.role}</span>
                  <a href={p.url} target="_blank" rel="noreferrer">{p.company}</a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {STAGES.slice(0, -1).map((stage) => (
          <StageSection key={stage.id} stage={stage}>{demoFor(stage.id)}</StageSection>
        ))}

        <StageSection stage={STOP}>
          <div className="il-quotes">
            {QUOTES.map((q) => (
              <figure className="il-quote" key={q.who}>
                <blockquote>{q.text}</blockquote>
                <figcaption>{q.who}</figcaption>
              </figure>
            ))}
          </div>
          <OpenNow />
        </StageSection>
      </main>

      <footer className="il-foot">
        <div className="il-wrap">
          <div className="il-foot-cols">
            {FOOTER.columns.map((c) => (
              <div key={c.title}>
                <h3>{c.title}</h3>
                <ul>
                  {c.links.map((l) => (
                    <li key={l.href + l.label}>
                      {l.href.startsWith("mailto:") ? <a href={l.href}>{l.label}</a> : <Link href={l.href}>{l.label}</Link>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="il-foot-line">{FOOTER.line}</div>
        </div>
      </footer>
    </div>
  );
}
