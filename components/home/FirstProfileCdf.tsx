import Diagram from "@/components/home/Diagram";
import { DEMO_STREAM } from "@/lib/home/copy";
import { CDF_MIN_ROLES } from "@/lib/home/placeholders";
import "./first-profile-cdf.css";

// Time to first profile across closed roles, as a cumulative curve. Server
// rendered, no JavaScript. With no data (or fewer than CDF_MIN_ROLES roles)
// it draws the axes and a dashed hairline at mid height under the word
// "measuring"; no numbers anywhere, since none exist yet. With data it draws
// a step CDF from the sorted hours and marks p50 and p90 with light-green
// ticks; the figures themselves sit in the tiles above. Every word is HTML
// around the SVG, not inside it, so it keeps its size at every width.

const W = 760;
const H = 240;
const L = 28;
const R = 744;
const T = 28;
const B = 196;

type Props = {
  /** Hours to first profile per closed role, ascending. */
  hours?: number[];
  p50?: number | null;
  p90?: number | null;
  /** True once enough roles have closed for the curve to be reported. */
  ready?: boolean;
};

function stepPath(hours: number[], x: (h: number) => number, y: (s: number) => number): string {
  const n = hours.length;
  const parts = [`M${x(0)} ${y(0)}`];
  hours.forEach((h, i) => {
    parts.push(`H${x(h)}`, `V${y((i + 1) / n)}`);
  });
  parts.push(`H${R}`);
  return parts.join(" ");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export default function FirstProfileCdf({ hours = [], p50 = null, p90 = null, ready = false }: Props) {
  const drawn = ready && hours.length >= CDF_MIN_ROLES;
  const maxHours = drawn ? Math.max(...hours) * 1.08 : 1;
  const x = (h: number) => round(L + (Math.min(h, maxHours) / maxHours) * (R - L));
  const y = (s: number) => round(B - s * (B - T));
  const mid = (T + B) / 2;

  return (
    <div className="il-cdf-wrap">
      <span className="il-cdf-axis il-cdf-axis-y" aria-hidden="true">{DEMO_STREAM.axisY}</span>
      {!drawn && <span className="il-cdf-measuring" aria-hidden="true">{DEMO_STREAM.measuring}</span>}
      <Diagram id="il-cdf" className="il-cdf" title={DEMO_STREAM.chartTitle} desc={DEMO_STREAM.chartDesc} viewBox={`0 0 ${W} ${H}`}>
      {/* axes */}
      <line className="il-cdf-hair" x1={L} y1={T} x2={L} y2={B} />
      <line className="il-cdf-hair" x1={L} y1={B} x2={R} y2={B} />

      {drawn ? (
        <g>
          <path className="il-cdf-curve" d={stepPath(hours, x, y)} />
          {p50 !== null && <line className="il-cdf-tick" x1={x(p50)} y1={B} x2={x(p50)} y2={y(0.5)} />}
          {p90 !== null && <line className="il-cdf-tick" x1={x(p90)} y1={B} x2={x(p90)} y2={y(0.9)} />}
        </g>
      ) : (
        <line className="il-cdf-hair il-cdf-dash" x1={L} y1={mid} x2={R} y2={mid} />
      )}
    </Diagram>
      <span className="il-cdf-axis il-cdf-axis-x" aria-hidden="true">{DEMO_STREAM.axisX}</span>
    </div>
  );
}
