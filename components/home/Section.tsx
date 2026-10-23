import Link from "next/link";
import type { Fact, Section as SectionCopy } from "@/lib/home/copy";
import { LABELS } from "@/lib/home/copy";

// One homepage section, Modal-shaped: eyebrow with a 12px mark, heading,
// one-line sub, the "means / you get" pair, a demo slot, three facts, one
// link. The demo is passed as children; until a demo exists the slot shows
// a quiet pending panel so the page reads honestly on the preview.

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="il-eyebrow">
      <i aria-hidden="true" />
      {children}
    </div>
  );
}

export function MeansGets({ means, getsYou }: { means: string; getsYou: string }) {
  if (!means && !getsYou) return null;
  return (
    <dl className="il-mg">
      {means && (
        <div>
          <dt>{LABELS.means}</dt>
          <dd>{means}</dd>
        </div>
      )}
      {getsYou && (
        <div>
          <dt>{LABELS.getsYou}</dt>
          <dd>{getsYou}</dd>
        </div>
      )}
    </dl>
  );
}

export function Facts({ facts }: { facts: Fact[] }) {
  if (!facts.length) return null;
  return (
    <ul className="il-facts">
      {facts.map((f) => (
        <li key={f.title}>
          <i aria-hidden="true" />
          <h4>{f.title}</h4>
          <p>{f.body}</p>
        </li>
      ))}
    </ul>
  );
}

export function DemoSlot({
  description,
  buildStep,
  children,
  className,
}: {
  description: string;
  buildStep?: number;
  children?: React.ReactNode;
  className?: string;
}) {
  if (children) {
    return (
      <div className={`il-demo ${className ?? ""}`} role="img" aria-label={description}>
        {children}
      </div>
    );
  }
  return (
    <div className={`il-demo il-demo-pending ${className ?? ""}`} aria-label={description}>
      <span className="il-demo-tag">
        {LABELS.demoPending}
        {buildStep ? `, build step ${buildStep}` : ""}
      </span>
      <p>{description}</p>
    </div>
  );
}

export function CtaLink({ label, href }: { label: string; href: string }) {
  const external = href.startsWith("mailto:") || href.startsWith("http");
  return external ? (
    <a className="il-link" href={href}>{label}</a>
  ) : (
    <Link className="il-link" href={href}>{label}</Link>
  );
}

export default function Section({ copy, children }: { copy: SectionCopy; children?: React.ReactNode }) {
  return (
    <section
      className={`il-section${copy.tone === "light" ? " il-light" : ""}`}
      id={copy.id}
      aria-labelledby={`${copy.id}-h`}
    >
      <div className="il-wrap">
        <div className="il-sec-head">
          <Eyebrow>{copy.eyebrow}</Eyebrow>
          <h2 className="il-h2" id={`${copy.id}-h`}>{copy.heading}</h2>
          {copy.sub && <p className="il-lede">{copy.sub}</p>}
          <MeansGets means={copy.means} getsYou={copy.getsYou} />
        </div>
        {children ?? <DemoSlot description={copy.demo} buildStep={copy.buildStep} />}
        <Facts facts={copy.facts} />
        <div className="il-sec-foot">
          <CtaLink label={copy.cta.label} href={copy.cta.href} />
        </div>
      </div>
    </section>
  );
}
