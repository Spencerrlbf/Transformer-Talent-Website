"use client";

import { useEffect, useState } from "react";

const LINES: { cls?: string; html: string }[] = [
  { html: `<span class="p">$</span> tt match ./senior-ml-infra.pdf` },
  { cls: "c", html: `# parsing job description… <span class="ok">done (2.1s)</span>` },
  { cls: "c", html: `# role: Senior ML Infrastructure Engineer · SF · $200–320k` },
  { cls: "c", html: `# scanning 290,441 candidate vectors… <span class="ok">done (0.6s)</span>` },
  { cls: "out", html: `→ TT-01 · Staff SWE · 12y · Bay Area · ex-Google <span class="ok">0.89</span>` },
  { cls: "out", html: `→ TT-02 · Sr Infra Eng · 9y · SF · ex-Stripe <span class="ok">0.86</span>` },
  { cls: "out", html: `→ TT-03 · ML Platform · 8y · SF · ex-Meta <span class="ok">0.84</span>` },
  { cls: "c", html: `# 2 more · anonymized · introductions on request` },
];

export default function TerminalHero() {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown >= LINES.length) return;
    const delay = shown === 0 ? 500 : LINES[shown - 1].cls === "c" ? 550 : 320;
    const id = setTimeout(() => setShown((s) => s + 1), delay);
    return () => clearTimeout(id);
  }, [shown]);

  return (
    <div className="term b3" aria-hidden="true">
      <div className="term-head">
        <span className="dot r" />
        <span className="dot y" />
        <span className="dot g" />
      </div>
      <div className="term-body">
        {LINES.slice(0, shown).map((l, i) => (
          <div key={i} className={l.cls} dangerouslySetInnerHTML={{ __html: l.html }} />
        ))}
        <div>
          <span className="p">$</span> <span className="cursor" />
        </div>
      </div>
    </div>
  );
}
