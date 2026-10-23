"use client";
// The hero stage: a dotted field where the market side is already lit when
// the page loads, and the brief plus each review light more of it while a
// terminal types the serve log. Pure presentation; no data behind it.
import { useEffect, useRef } from "react";

const COLS = 36;
const ROWS = 16;
const LINES = [
  'prefill   market        <s>cached</s>  25,000 engineers, already read',
  'prefill   brief         <s>1 pass</s>  team, bar, comp, last hire',
  'decode    profile 1     <s>ok</s>      reason attached',
  'append    review        <s>cached</s>  pass: too junior',
  'decode    profile 2     <s>ok</s>      sharper',
];

export default function CacheStage() {
  const gridRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = gridRef.current;
    const term = termRef.current;
    if (!grid || !term) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cells = Array.from(grid.querySelectorAll("i"));
    const market = cells.filter((_, k) => k % COLS < 22);
    const yours = cells.filter((_, k) => k % COLS >= 24);
    const lines = Array.from(term.querySelectorAll<HTMLDivElement>(".ln[data-t]"));
    const timers: number[] = [];
    let stopped = false;
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };

    function type(el: HTMLElement, html: string, done: () => void) {
      if (reduce) { el.innerHTML = html; done(); return; }
      const plain = html.replace(/<[^>]+>/g, "");
      let k = 0;
      const t = window.setInterval(() => {
        if (stopped) { window.clearInterval(t); return; }
        k++;
        el.textContent = plain.slice(0, k);
        if (k >= plain.length) { window.clearInterval(t); el.innerHTML = html; done(); }
      }, 18);
      timers.push(t);
    }
    function light(n: number) {
      const pool = yours.filter((i) => !i.classList.contains("on"));
      for (let j = 0; j < n && pool.length; j++) {
        const p = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        p.classList.add("on", "hot");
        later(() => p.classList.remove("hot"), 600);
      }
    }
    function pulseMarket() {
      market.slice().sort(() => Math.random() - 0.5).slice(0, 40).forEach((i, k) =>
        later(() => { i.classList.add("on"); later(() => i.classList.remove("on"), 500); }, k * 25));
    }
    let step = 0;
    function next() {
      if (stopped) return;
      if (step >= lines.length) {
        later(() => {
          yours.forEach((i) => i.classList.remove("on"));
          lines.forEach((l) => { l.textContent = ""; });
          step = 0;
          later(next, 900);
        }, 5200);
        return;
      }
      const el = lines[step];
      const html = el.getAttribute("data-t") || "";
      type(el, html, () => {
        if (step === 0) pulseMarket();
        else if (step === 1) light(60);
        else light(18);
        step++;
        later(next, reduce ? 300 : 700);
      });
    }
    later(next, 600);
    return () => { stopped = true; timers.forEach((t) => { window.clearTimeout(t); window.clearInterval(t); }); };
  }, []);

  const cells = [];
  for (let k = 0; k < COLS * ROWS; k++) cells.push(<i key={k} className={k % COLS < 22 ? "market" : undefined} />);

  return (
    <div className="il-stage" aria-hidden="true">
      <div className="il-grid" ref={gridRef}>{cells}</div>
      <div className="il-term" ref={termRef}>
        <div className="ln"><b>tt</b> serve --role &quot;Staff Platform Engineer&quot;</div>
        {LINES.map((l) => <div key={l} className="ln" data-t={l} />)}
        <div className="ln"><span className="cur" /></div>
      </div>
      <div className="il-legend"><span>prefilled market</span><span className="g">your context</span></div>
    </div>
  );
}
