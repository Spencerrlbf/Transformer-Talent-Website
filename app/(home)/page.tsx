import type { Metadata } from "next";
import Link from "next/link";
import { Inter, DM_Mono } from "next/font/google";
import Section, { CtaLink, DemoSlot, Eyebrow, Facts, MeansGets } from "@/components/home/Section";
import { PLACEMENTS } from "@/data/placements";
import {
  ATTENTION, CTA, CUSTOMERS, FOOTER, HERO, KV_CACHE, MARKET, NAV, PROOF, QUOTES, SCALE_TO_ZERO, TOP_K, TTFT,
} from "@/lib/home/copy";
import "./home.css";

// The inference-layer homepage. Plan: Recruitment-Matching/mocks/
// inference-layer/plan-v2.md. This is build step 1, the skeleton: chrome,
// every section's copy in its final shape, and a pending panel in each
// demo slot. Demos arrive in later steps. Every string is in
// lib/home/copy.ts, every number in lib/home/placeholders.ts.

const ilSans = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-il-sans" });
const ilMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-il-mono" });

export const metadata: Metadata = {
  title: { absolute: "Transformer Talent, the inference layer for hiring" },
  description:
    "Talent infrastructure for teams that develop, train, and serve. Senior AI and software engineers, placed at venture-backed start-ups. Pay on hire.",
};

function Pill({ label, href, primary }: { label: string; href: string; primary?: boolean }) {
  const cls = `il-pill ${primary ? "primary" : "ghost"}`;
  return href.startsWith("mailto:") ? (
    <a className={cls} href={href}>{label}</a>
  ) : (
    <Link className={cls} href={href}>{label}</Link>
  );
}

export default function Home() {
  return (
    <main className={`il-home ${ilSans.variable} ${ilMono.variable}`}>
      <div className="il-wrap">
        <nav className="il-nav" aria-label="Main">
          <Link className="il-brand" href="/"><b aria-hidden="true" />{NAV.brand}</Link>
          <div className="il-links">
            {NAV.links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
          </div>
          <div className="il-navright">
            <Pill label={NAV.login.label} href={NAV.login.href} />
            <Pill label={NAV.cta.label} href={NAV.cta.href} primary />
          </div>
        </nav>
      </div>

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
          <DemoSlot description={HERO.stageAria} buildStep={3} className="il-stage" />
          <div className="il-proof">
            <span className="il-proof-lead">{PROOF.lead}</span>
            <ul className="il-investors">
              {PROOF.investors.map((v) => <li key={v}>{v}</li>)}
            </ul>
          </div>
          <ul className="il-placed" aria-label="Recent placements">
            {PLACEMENTS.map((p) => (
              <li key={p.company}>
                <span className="il-placed-role">{p.role}</span>
                <a href={p.url} target="_blank" rel="noreferrer">{p.company}</a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Section copy={KV_CACHE}>
        <div className="il-tabs">
          <ol className="il-tablist" aria-label="Stages of the search">
            {KV_CACHE.tabs!.map((t) => <li key={t.id}><a href={`#${t.id}`}>{t.label}</a></li>)}
          </ol>
          <div className="il-tabpanels">
            {KV_CACHE.tabs!.map((t) => (
              <article className="il-tab" id={t.id} key={t.id}>
                <h3>{t.heading}</h3>
                <p className="il-tab-sub">{t.sub}</p>
                <MeansGets means={t.means} getsYou={t.getsYou} />
                <DemoSlot description={t.demo} buildStep={8} />
                <Facts facts={t.facts} />
              </article>
            ))}
          </div>
        </div>
      </Section>

      <Section copy={TOP_K} />
      <Section copy={ATTENTION} />
      <Section copy={MARKET} />
      <Section copy={TTFT} />

      <section className="il-section" id={CUSTOMERS.id} aria-labelledby={`${CUSTOMERS.id}-h`}>
        <div className="il-wrap">
          <div className="il-sec-head">
            <Eyebrow>{CUSTOMERS.eyebrow}</Eyebrow>
            <h2 className="il-h2" id={`${CUSTOMERS.id}-h`}>{CUSTOMERS.heading}</h2>
          </div>
          <div className="il-quotes">
            {QUOTES.map((q) => (
              <figure className="il-quote" key={q.who}>
                <blockquote>{q.text}</blockquote>
                <figcaption>{q.who}</figcaption>
              </figure>
            ))}
          </div>
          <DemoSlot description="Open now: three live roles, server-rendered from the roles list." buildStep={4} />
          <div className="il-sec-foot">
            <CtaLink label={CUSTOMERS.cta.label} href={CUSTOMERS.cta.href} />
          </div>
        </div>
      </section>

      <Section copy={SCALE_TO_ZERO} />

      <footer className="il-foot">
        <div className="il-wrap">
          <div className="il-foot-cols">
            {FOOTER.columns.map((c) => (
              <div key={c.title}>
                <h4>{c.title}</h4>
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
    </main>
  );
}
