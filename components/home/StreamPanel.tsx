import { DEMO_STREAM } from "@/lib/home/copy";
import { FIRST_PROFILE_HOURS, MARKET_READ_SHARE } from "@/lib/home/placeholders";
import { loadFirstAnswers } from "@/lib/home/first-answers";
import CoverageTicker from "./CoverageTicker";
import FirstProfileCdf from "./FirstProfileCdf";
import "./stream-panel.css";

// The stream stage demo: the roles we place scrolling, three tiles for time
// to first profile (median, p90) and the market-read share, and the
// cumulative curve. Figures come from data/first-answers.json through
// lib/home/first-answers.ts and fall back to lib/home/placeholders.ts; a null
// renders as "measuring" with a dashed underline and one note under the row.
// Async server component, no JavaScript on the client.

type Figure = { value: number | null; percent: boolean };

function Value({ value, percent, unit }: Figure & { unit: string }) {
  if (value === null) return <span className="il-tile-measuring">{DEMO_STREAM.measuring}</span>;
  const shown = percent ? `${Math.round(value * 100)}%` : String(Math.round(value));
  return (
    <>
      <b>{shown}</b>
      <span className="il-tile-unit">{unit}</span>
    </>
  );
}

export default async function StreamPanel() {
  const data = await loadFirstAnswers();
  const figures: Record<string, Figure> = {
    p50: { value: data.p50 ?? FIRST_PROFILE_HOURS.p50, percent: false },
    p90: { value: data.p90 ?? FIRST_PROFILE_HOURS.p90, percent: false },
    reads: { value: data.readShare ?? MARKET_READ_SHARE, percent: true },
  };
  const measuring = DEMO_STREAM.tiles.some((t) => (figures[t.id]?.value ?? null) === null);

  return (
    <div className="il-stream">
      <CoverageTicker />

      <div className="il-stream-part">
        <dl className="il-tiles">
          {DEMO_STREAM.tiles.map((tile) => {
            const fig = figures[tile.id] ?? { value: null, percent: false };
            return (
              <div className="il-tile" key={tile.id}>
                <dt className="il-tile-label">{tile.label}</dt>
                <dd className="il-tile-value">
                  <Value value={fig.value} percent={fig.percent} unit={tile.unit} />
                </dd>
              </div>
            );
          })}
        </dl>
        {measuring && <p className="il-tiles-note">{DEMO_STREAM.measuringNote}</p>}
      </div>

      <div className="il-stream-part">
        <FirstProfileCdf hours={data.hours} p50={data.p50} p90={data.p90} ready={data.ready} />
      </div>
    </div>
  );
}
