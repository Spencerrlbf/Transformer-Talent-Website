import Diagram from "@/components/home/Diagram";
import Reveal from "@/components/home/Reveal";
import { DEMO_COLD_START } from "@/lib/home/copy";
import "./market-cards.css";

// The cold start demo: three cards, each an original isometric line drawing.
// Slabs for the market read, two arrows between an engineer and a brief for
// the conversations already running, a small tree for the shared prefix per
// company. No text inside the drawings; the title under each card carries the
// words. Strokes carry pathLength="1" so market-cards.css can draw them from
// a dash offset of one to zero once Reveal marks the row as on screen.
// Without JavaScript the drawings are complete; under reduced motion too.

const VIEW = "0 0 300 200";

// Isometric slab: a rhombus top face, then the three visible edges down.
const SW = 72;
const SH = 42;
const ST = 12;

function slabTop(cx: number, cy: number, w = SW, h = SH) {
  return `M ${cx - w} ${cy} L ${cx} ${cy - h} L ${cx + w} ${cy} L ${cx} ${cy + h} Z`;
}

function slabSides(cx: number, cy: number, w = SW, h = SH, t = ST) {
  return `M ${cx - w} ${cy} v ${t} L ${cx} ${cy + h + t} L ${cx + w} ${cy + t} v ${-t} M ${cx} ${cy + h} v ${t}`;
}

// Upright rounded rect with a shallow extrusion up and to the right.
const DX = 8;
const DY = -5;

// A quarter-turn corner arc, clockwise (large-arc and sweep flags as numbers).
function corner(r: number) {
  return ["A", r, r, 0, 0, 1].join(" ");
}

function boxFront(x: number, y: number, w: number, h: number, r: number) {
  const a = corner(r);
  return [
    `M ${x + r} ${y} H ${x + w - r} ${a} ${x + w} ${y + r}`,
    `V ${y + h - r} ${a} ${x + w - r} ${y + h} H ${x + r}`,
    `${a} ${x} ${y + h - r} V ${y + r} ${a} ${x + r} ${y} Z`,
  ].join(" ");
}

function boxDepth(x: number, y: number, w: number, h: number, r: number) {
  return [
    `M ${x + r} ${y} l ${DX} ${DY} H ${x + w - r + DX} L ${x + w + DX} ${y + r + DY}`,
    `V ${y + h - r + DY} l ${-DX} ${-DY} M ${x + w} ${y + r} l ${DX} ${DY}`,
  ].join(" ");
}

const DRAW = "il-mc-draw";
const GREEN = `${DRAW} il-mc-green`;
const HAIR = `${DRAW} il-mc-hair`;
const DEEP = `${DRAW} il-mc-deep`;
const DIM = `${DRAW} il-mc-dim`;

// 1. The market, mapped: three slabs, the top one lit, a few marks on it.
function Mapped() {
  const dots: [number, number][] = [[150, 50], [128, 64], [172, 70], [150, 80], [184, 58], [116, 54]];
  return (
    <>
      <path className={HAIR} d={slabTop(150, 136)} pathLength={1} />
      <path className={HAIR} d={slabSides(150, 136)} pathLength={1} />
      <path className={HAIR} d={slabTop(150, 100)} pathLength={1} />
      <path className={HAIR} d={slabSides(150, 100)} pathLength={1} />
      <path className={GREEN} d={slabTop(150, 64)} pathLength={1} />
      <path className={GREEN} d={slabSides(150, 64)} pathLength={1} />
      {dots.map(([x, y]) => (
        <circle key={`${x}-${y}`} className="il-mc-fade il-mc-dot" cx={x} cy={y} r={2.2} />
      ))}
    </>
  );
}

// 2. In conversation: an engineer tile and a brief, arrows both ways.
function Conversation() {
  return (
    <>
      <path className={DIM} d={boxFront(44, 84, 56, 48, 8)} pathLength={1} />
      <path className={HAIR} d={boxDepth(44, 84, 56, 48, 8)} pathLength={1} />
      <circle className={DIM} cx={72} cy={101} r={6} pathLength={1} />
      <path className={DIM} d="M 60 123 a 12 12 0 0 1 24 0" pathLength={1} />

      <path className={DIM} d={boxFront(196, 42, 64, 112, 8)} pathLength={1} />
      <path className={HAIR} d={boxDepth(196, 42, 64, 112, 8)} pathLength={1} />
      <path className={HAIR} d="M 208 62 H 248 M 208 76 H 240 M 208 90 H 248 M 208 104 H 232" pathLength={1} />

      <path className={GREEN} d="M 106 94 C 136 66, 164 66, 190 86" pathLength={1} />
      <path className={GREEN} d="M 181 85 L 190 86 L 187 77" pathLength={1} />
      <path className={HAIR} d="M 190 128 C 164 154, 136 154, 106 132" pathLength={1} />
      <path className={HAIR} d="M 115 133 L 106 132 L 110 141" pathLength={1} />
    </>
  );
}

// 3. Shared prefix: root over child over two leaves, nodes as small tiles.
function Prefix() {
  const NW = 16;
  const NH = 9;
  return (
    <>
      <path className={GREEN} d="M 150 49 V 91" pathLength={1} />
      <path className={DEEP} d="M 150 109 C 150 132, 100 128, 100 151" pathLength={1} />
      <path className={DEEP} d="M 150 109 C 150 132, 200 128, 200 151" pathLength={1} />
      <path className={GREEN} d={slabTop(150, 40, NW, NH)} pathLength={1} />
      <path className={GREEN} d={slabSides(150, 40, NW, NH, 5)} pathLength={1} />
      <path className={GREEN} d={slabTop(150, 100, NW, NH)} pathLength={1} />
      <path className={DIM} d={slabTop(100, 160, NW, NH)} pathLength={1} />
      <path className={DIM} d={slabTop(200, 160, NW, NH)} pathLength={1} />
    </>
  );
}

const DRAWINGS: Record<string, () => React.JSX.Element> = {
  mapped: Mapped,
  conversation: Conversation,
  prefix: Prefix,
};

export default function MarketCards() {
  return (
    <Reveal className="il-mc">
      <ul className="il-mc-row">
        {DEMO_COLD_START.cards.map((card) => {
          const Drawing = DRAWINGS[card.id];
          return (
            <li key={card.id} className="il-mc-card">
              <Diagram id={`il-mc-${card.id}`} className="il-mc-svg" title={card.title} desc={card.desc} viewBox={VIEW}>
                {Drawing ? <Drawing /> : null}
              </Diagram>
              <p className="il-mc-title">{card.title}</p>
            </li>
          );
        })}
      </ul>
    </Reveal>
  );
}
