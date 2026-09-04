import { type PlanOption, type Units, fmtDist } from "@/lib/api";

// The turn-by-turn list as a wrist pace band: a strip of paper with the
// distance down one edge, the street beside it, and a rule wherever a new
// mile (or kilometre) begins, the way runners tape their splits on.

export default function PaceBand({ cues, units, total }: { cues: PlanOption["cues"]; units: Units; total: number }) {
  const perUnit = units === "mi" ? 1 : 1.609344;   // cue distances come in miles
  return (
    <ol className="band" aria-label="Turn by turn">
      {cues.map((c, i) => {
        const before = i ? Math.floor(cues[i - 1].cum_mi * perUnit) : 0;
        const here = Math.floor(c.cum_mi * perUnit);
        return (
          <li key={c.n} className={`band-row${i && here > before ? " band-mark" : ""}`}>
            <span className="band-d font-display">{fmtDist(c.cum_mi, units)}</span>
            <span className="band-t">
              <b className="band-w">{c.word}</b> {c.street}
              <span className="band-len"> · {fmtDist(c.mi, units)}</span>
            </span>
          </li>
        );
      })}
      <li className="band-row band-end">
        <span className="band-d font-display">{fmtDist(total, units)}</span>
        <span className="band-t">
          <b className="band-w">Finish</b>
        </span>
      </li>
    </ol>
  );
}
