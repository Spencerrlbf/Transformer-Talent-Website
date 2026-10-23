import Link from "next/link";
import type { Fact, Stage } from "@/lib/home/copy";
import { LABELS, STAGES } from "@/lib/home/copy";

// One stage of the request, Modal-shaped: a trace strip showing where this
// stage sits in the pipeline, the stage name as the eyebrow, a heading that
// says what happens in the search at that stage, one-line sub, a demo slot,
// three facts, one link. Until a demo exists the slot shows a quiet pending
// panel so the page reads honestly on the preview.

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function Trace({ current }: { current: string }) {
  return (
    <ol className="il-trace" aria-label={LABELS.trace}>
      {STAGES.map((s, i) => (
        <li key={s.id} aria-current={s.id === current ? "step" : undefined}>
          <a href={`#${s.id}`}>
            <span>{pad(i + 1)}</span> {s.name.split(",")[0]}
          </a>
        </li>
      ))}
    </ol>
  );
}

export function Eyebrow({ index, children }: { index?: number; children: React.ReactNode }) {
  return (
    <div className="il-eyebrow">
      <i aria-hidden="true" />
      {index !== undefined && (
        <span className="il-eyebrow-n">
          {pad(index)} {LABELS.stageOf} {pad(STAGES.length)}
        </span>
      )}
      {children}
    </div>
  );
}

export function Facts({ facts }: { facts: Fact[] }) {
  if (!facts.length) return null;
  return (
    <ul className="il-facts">
      {facts.map((f) => (
        <li key={f.title}>
          <i aria-hidden="true" />
          <h3>{f.title}</h3>
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
    <div className={`il-demo il-demo-pending ${className ?? ""}`}>
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

export default function StageSection({ stage, children }: { stage: Stage; children?: React.ReactNode }) {
  const index = STAGES.findIndex((s) => s.id === stage.id) + 1;
  return (
    <section className="il-section" id={stage.id} aria-labelledby={`${stage.id}-h`}>
      <div className="il-wrap">
        <Trace current={stage.id} />
        <div className="il-sec-head">
          <Eyebrow index={index}>{stage.name}</Eyebrow>
          <h2 className="il-h2" id={`${stage.id}-h`}>{stage.heading}</h2>
          {stage.sub && <p className="il-lede">{stage.sub}</p>}
        </div>
        {children ?? <DemoSlot description={stage.demo} buildStep={stage.buildStep} />}
        <Facts facts={stage.facts} />
        <div className="il-sec-foot">
          <CtaLink label={stage.cta.label} href={stage.cta.href} />
        </div>
      </div>
    </section>
  );
}
