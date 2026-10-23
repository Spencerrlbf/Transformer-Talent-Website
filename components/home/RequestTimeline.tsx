import type { CSSProperties } from "react";
import Diagram from "@/components/home/Diagram";
import { HERO, LABELS, STAGES } from "@/lib/home/copy";
import { SAMPLE_REVIEWS } from "@/lib/home/sample";

// The hero visual and the page's table of contents: one request drawn left
// to right through the seven stages, then a shorter second lane for role two
// at the same company, which starts with its cache partly filled and reaches
// its first profile earlier. Server rendered, no JavaScript. Motion is CSS
// only: every drawn element carries --phase (its position along the request)
// and home.css delays its draw-in by that phase. Only text labels, read from
// STAGES so the hero and the sections can never drift; no numbers, no times.

const W = 1058;
const H = 520;
const X0 = 40;
const X1 = 1018;
const TOTAL_MS = 1800;

const C = {
  hair: "rgba(255,255,255,0.1)",
  dim: "rgba(255,255,255,0.03)",
  green: "#7fee64",
  light: "#9efb87",
  deep: "#124f11",
  mark: "#4b4d4a",
};

// Lane one: the request. Lane two: role two, same company.
const A = 206;
const B = 386;
const LABEL_Y = 114;

const DECODE_H = [10, 16, 12, 18, 8, 14];

type Phased = CSSProperties & { "--phase": number };

function phase(x: number): Phased {
  return { "--phase": Math.round(((x - X0) / (X1 - X0)) * 1000) / 1000 };
}

function grow(x: number, toX: number): Phased {
  // A bar that keeps filling for the rest of the request after it starts.
  const p = (x - X0) / (X1 - X0);
  const span = ((toX - x) / (X1 - X0)) * TOTAL_MS;
  return { "--phase": Math.round(p * 1000) / 1000, animationDuration: `${Math.round(span)}ms`, animationTimingFunction: "linear" };
}

function Tick({ x, y, h, w = 1.5, color = C.green }: { x: number; y: number; h: number; w?: number; color?: string }) {
  return <line className="il-tl-draw" x1={x} y1={y} x2={x} y2={y - h} stroke={color} strokeWidth={w} pathLength={1} style={phase(x)} />;
}

function Dot({ x, y, r, color }: { x: number; y: number; r: number; color: string }) {
  return <circle className="il-tl-fade" cx={x} cy={y} r={r} fill={color} style={phase(x)} />;
}

function Cell({ x, y }: { x: number; y: number }) {
  return <rect className="il-tl-fade" x={x} y={y} width={16} height={14} rx={2} fill={C.green} style={phase(x)} />;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let x = from; x <= to; x += step) out.push(x);
  return out;
}

export default function RequestTimeline() {
  // The short stage name, as the trace strip shows it ("cold start", not the full phrase).
  const names = STAGES.map((s) => s.name.split(",")[0]);
  const [coldStart, prefill, kvCache, decode, sampling, stream, stopToken] = names;
  const T = HERO.timeline;

  // Lane one x positions.
  const req = 190;
  const pre = [196, 280] as const;
  const dec = range(372, 530, 10);
  const cut = [548, 690] as const;
  const above = [562, 588, 614, 640, 666];
  const below = [556, 572, 590, 606, 622];
  const str = [720, 790, 860, 930];
  const reviews = [752, 822];
  const stop = 1000;

  // Lane two x positions: same request, shorter prefill, earlier first profile.
  const pre2 = [196, 236] as const;
  const shared = [196, 400] as const;
  const dec2 = range(250, 330, 10);
  const cut2 = [345, 410] as const;
  const above2 = [358, 378, 398];
  const below2 = [352, 366, 382, 396];
  const str2 = [430, 500, 570, 640];
  const end2 = 760;
  const stop2 = 740;

  return (
    <Diagram id="il-request" className="il-tl" title={T.title} desc={HERO.stageAria} viewBox={`0 0 ${W} ${H}`}>
      {/* cold start: the market, resident before the request */}
      <rect x={X0} y={A - 80} width={req - X0} height={160} rx={2} fill={C.dim} />
      {[62, 88, 109, 131, 156, 176].map((x, i) => (
        <circle key={x} cx={x} cy={A + [-18, 8, -26, 20, -6, 12][i]} r={2} fill={C.mark} />
      ))}

      {/* lane one axis */}
      <line className="il-tl-hair il-tl-draw" x1={X0} y1={A} x2={X1} y2={A} stroke={C.hair} strokeWidth={1} pathLength={1} style={grow(X0, X1)} />

      {/* kv cache: starts at prefill, grows under the axis for the rest of the request */}
      <line className="il-tl-draw" x1={pre[0]} y1={A + 21} x2={X1} y2={A + 21} stroke={C.deep} strokeWidth={14} pathLength={1} style={grow(pre[0], X1)} />
      {reviews.map((x) => <Cell key={x} x={x} y={A + 14} />)}

      {/* request lands, then the prefill block */}
      <Dot x={req} y={A} r={5} color={C.green} />
      <rect className="il-tl-fade" x={pre[0]} y={A - 12} width={pre[1] - pre[0]} height={24} rx={2} fill={C.green} style={phase(pre[0])} />

      {/* decode: a run of short ticks above the axis */}
      {dec.map((x, i) => <Tick key={x} x={x} y={A - 6} h={DECODE_H[i % DECODE_H.length]} />)}

      {/* sampling: the cut, marks above it, dimmer marks held back below */}
      <line className="il-tl-hair il-tl-draw" x1={cut[0]} y1={A - 36} x2={cut[1]} y2={A - 36} stroke={C.hair} strokeWidth={1} pathLength={1} style={phase(cut[0])} />
      {above.map((x, i) => <Dot key={x} x={x} y={A - 50 - (i % 3) * 4} r={3} color={C.green} />)}
      {below.map((x, i) => <Dot key={x} x={x} y={A - 14 - (i % 2) * 8} r={2.5} color={C.mark} />)}

      {/* stream: larger ticks, the first is the first profile */}
      {str.map((x, i) => <Tick key={x} x={x} y={A + 20} h={46} w={2} color={i === 0 ? C.light : C.green} />)}
      <line className="il-tl-hair il-tl-fade" x1={str[0]} y1={A + 30} x2={str[0]} y2={B + 8} stroke={C.hair} strokeWidth={1} style={phase(str[0])} />

      {/* stop token: signed offer */}
      <Dot x={stop} y={A} r={7} color={C.light} />

      {/* lane two: role two, same company */}
      <line className="il-tl-hair il-tl-draw" x1={X0} y1={B} x2={end2} y2={B} stroke={C.hair} strokeWidth={1} pathLength={1} style={grow(X0, end2)} />
      <line x1={shared[0]} y1={B + 21} x2={shared[1]} y2={B + 21} stroke={C.deep} strokeWidth={14} />
      <line className="il-tl-draw" x1={shared[1]} y1={B + 21} x2={end2} y2={B + 21} stroke={C.deep} strokeWidth={14} pathLength={1} style={grow(shared[1], end2)} />
      <Dot x={req} y={B} r={5} color={C.green} />
      <rect className="il-tl-fade" x={pre2[0]} y={B - 12} width={pre2[1] - pre2[0]} height={24} rx={2} fill={C.green} style={phase(pre2[0])} />
      {dec2.map((x, i) => <Tick key={x} x={x} y={B - 6} h={DECODE_H[(i + 2) % DECODE_H.length]} />)}
      <line className="il-tl-hair il-tl-draw" x1={cut2[0]} y1={B - 36} x2={cut2[1]} y2={B - 36} stroke={C.hair} strokeWidth={1} pathLength={1} style={phase(cut2[0])} />
      {above2.map((x, i) => <Dot key={x} x={x} y={B - 50 - (i % 3) * 4} r={3} color={C.green} />)}
      {below2.map((x, i) => <Dot key={x} x={x} y={B - 14 - (i % 2) * 8} r={2.5} color={C.mark} />)}
      {str2.map((x, i) => <Tick key={x} x={x} y={B + 20} h={46} w={2} color={i === 0 ? C.light : C.green} />)}
      <Dot x={stop2} y={B} r={6} color={C.light} />

      {/* labels: the seven stage names above their segments, then notes */}
      <g aria-hidden="true" className="il-tl-labels">
        <text className="il-tl-fade" x={X0} y={LABEL_Y}>{coldStart}</text>
        <text className="il-tl-fade" x={pre[0]} y={LABEL_Y} style={phase(pre[0])}>{prefill}</text>
        <text className="il-tl-fade" x={292} y={LABEL_Y} style={phase(292)}>{kvCache}</text>
        <text className="il-tl-fade" x={dec[0] + 20} y={LABEL_Y} style={phase(dec[0])}>{decode}</text>
        <text className="il-tl-fade" x={cut[0]} y={LABEL_Y} style={phase(cut[0])}>{sampling}</text>
        <text className="il-tl-fade" x={str[0]} y={LABEL_Y} style={phase(str[0])}>{stream}</text>
        <text className="il-tl-fade" x={X1} y={LABEL_Y} textAnchor="end" style={phase(stop)}>{stopToken}</text>

        <text className="il-tl-fade il-tl-note" x={cut[1] - 60} y={A - 6} style={phase(cut[1])}>{T.heldBack}</text>
        <text className="il-tl-fade il-tl-hi" x={str[0] + 8} y={A - 44} style={phase(str[0])}>{T.firstProfile}</text>
        <text className="il-tl-fade il-tl-note" x={reviews[0]} y={A + 50} style={phase(reviews[0])}>{SAMPLE_REVIEWS[0]}</text>
        <text className="il-tl-fade il-tl-note" x={reviews[1]} y={A + 68} style={phase(reviews[1])}>{SAMPLE_REVIEWS[1]}</text>
        <text className="il-tl-fade il-tl-tag" x={X1} y={A + 50} textAnchor="end" style={phase(reviews[0])}>{LABELS.sample}</text>

        <text className="il-tl-note" x={X0} y={B - 52}>{T.roleTwo}</text>
        <text className="il-tl-note" x={shared[0]} y={B + 50}>{T.sharedPrefix}</text>
        <text className="il-tl-fade il-tl-hi" x={str2[0] + 8} y={B - 44} style={phase(str2[0])}>{T.firstProfile}</text>
      </g>
    </Diagram>
  );
}
