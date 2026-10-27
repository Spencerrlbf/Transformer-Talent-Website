import { COVERAGE, DEMO_STREAM } from "@/lib/home/copy";
import "./coverage-ticker.css";

// The roles we place, scrolling. CSS only: the list is rendered twice and the
// track slides one list width per loop. The second copy is decoration and is
// hidden from assistive technology; the first copy is the readable list.
// Under prefers-reduced-motion the track holds still and shows the first items.

function Items({ hidden }: { hidden?: boolean }) {
  return (
    <ul className="il-ticker-list" aria-hidden={hidden ? "true" : undefined}>
      {COVERAGE.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export default function CoverageTicker() {
  return (
    <div className="il-ticker">
      <div className="il-ticker-label">{DEMO_STREAM.tickerLabel}</div>
      <div className="il-ticker-mask">
        <div className="il-ticker-track">
          <Items />
          <Items hidden />
        </div>
      </div>
    </div>
  );
}
