import { useEffect, useId, useMemo, useRef, useState } from "react";
import { WORDMARK_DOT, WORDMARK_DOT_RUN, WORDMARK_OUTLINE_D, WORDMARK_VIEWBOX } from "@/lib/wordmark";

/** The wordmark: DRAWMYRUN as a run, the route in orange and the green
 *  start dot with its ring standing on the baseline between Y and R, the
 *  period of drawmy.run; sized by height. Etched, the letters are cut into
 *  the deck (the paint in a recess, its top edge in the recess wall's
 *  shadow, the deck's edge above, the lip lit below) and the dot stands on
 *  top of them, a lamp on the deck rather than paint in the cut. Printed, it
 *  is simply the mark, as on the bib's paper. With `run`, a pointer over the
 *  mark (or a tap) sends the dot off along the route through DRAWMY, back
 *  to its place before the R. */
export default function Wordmark({ height, className, title = "drawmy.run", etched = false, run = false }: { height: number; className?: string; title?: string; etched?: boolean; run?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const cut = `etch-${id}`;
  const motion = useRef<SVGAnimateMotionElement>(null);
  // With the run on, the dot waits at the start of the route (the foot of
  // the D) as the page opens, runs the route half a second later and stays
  // where it ends, between Y and R; a pointer or a tap sends it round
  // again. So the run's path is put in the frame of that start, and the
  // dot's resting place is the start until the run has happened. Anyone
  // who has asked their device for less motion gets the mark at rest.
  const [still, setStill] = useState(false);
  const running = run && !still;
  const { sx, sy, path } = useMemo(() => {
    const pts = Array.from(WORDMARK_DOT_RUN.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g), (m) => [Number(m[1]), Number(m[2])]);
    const [sx, sy] = pts[0];
    return { sx, sy, path: pts.map(([x, y], i) => `${i ? "L" : "M"}${(x - sx).toFixed(2)} ${(y - sy).toFixed(2)}`).join("") };
  }, []);
  const go = () => {
    const m = motion.current as (SVGAnimateMotionElement & { beginElement?: () => void }) | null;
    m?.beginElement?.();
  };
  useEffect(() => {
    if (!run) return;
    const less = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const t = window.setTimeout(
      () => {
        if (less) {
          setStill(true);
          return;
        }
        const m = motion.current as (SVGAnimateMotionElement & { beginElement?: () => void }) | null;
        m?.beginElement?.();
      },
      less ? 0 : 500,
    );
    return () => window.clearTimeout(t);
  }, [run]);
  return (
    <svg
      className={className}
      viewBox={WORDMARK_VIEWBOX}
      height={height}
      role="img"
      aria-label={title}
      onMouseEnter={run ? go : undefined}
      onClick={run ? go : undefined}
    >
      {etched && (
        <defs>
          {/* in the mark's own units: a pixel is about a fifth of a unit at the header's size */}
          <filter id={cut} x="-2%" y="-14%" width="104%" height="128%" colorInterpolationFilters="sRGB">
            {/* the deck's edge above the cut: the mark moved up, less itself */}
            <feOffset in="SourceAlpha" dy="-0.2" result="up" />
            <feComposite in="up" in2="SourceAlpha" operator="out" result="wallA" />
            <feFlood floodColor="#000" floodOpacity="0.85" result="black" />
            <feComposite in="black" in2="wallA" operator="in" result="wall" />
            {/* the lip below the cut, catching the light */}
            <feOffset in="SourceAlpha" dy="0.2" result="down" />
            <feComposite in="down" in2="SourceAlpha" operator="out" result="lipA" />
            <feFlood floodColor="#fff" floodOpacity="0.22" result="white" />
            <feComposite in="white" in2="lipA" operator="in" result="lip" />
            {/* the paint's own top edge in the wall's shadow, inside the cut: a thin line, so the paint stays bright */}
            <feOffset in="SourceAlpha" dy="0.2" result="down2" />
            <feComposite in="SourceAlpha" in2="down2" operator="out" result="shadeA" />
            <feGaussianBlur in="shadeA" stdDeviation="0.06" result="shadeB" />
            <feComposite in="shadeB" in2="SourceAlpha" operator="in" result="shadeC" />
            <feFlood floodColor="#000" floodOpacity="0.42" result="black2" />
            <feComposite in="black2" in2="shadeC" operator="in" result="shade" />
            <feMerge>
              <feMergeNode in="wall" />
              <feMergeNode in="lip" />
              <feMergeNode in="SourceGraphic" />
              <feMergeNode in="shade" />
            </feMerge>
          </filter>
          {/* the dot stands proud of the deck: a little shadow under it */}
          <filter id={`lamp-${id}`} x="-40%" y="-40%" width="180%" height="200%">
            <feDropShadow dx="0" dy="0.12" stdDeviation="0.06" floodColor="#000" floodOpacity="0.7" />
          </filter>
        </defs>
      )}
      <path d={WORDMARK_OUTLINE_D} fill={etched ? "#fa5202" : "#fc5200"} fillRule="evenodd" filter={etched ? `url(#${cut})` : undefined} />
      <circle
        cx={WORDMARK_DOT.x + (running ? sx : 0)}
        cy={WORDMARK_DOT.y + (running ? sy : 0)}
        r={WORDMARK_DOT.r}
        fill="#12b886"
        stroke="#f6f3ec"
        strokeWidth={0.22}
        filter={etched ? `url(#lamp-${id})` : undefined}
      >
        {running && (
          /* the run: along the route through DRAWMY from where the dot waits to its place, easing off the line and back onto it, and held there after */
          <animateMotion ref={motion} path={path} begin="indefinite" dur="2.6s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.35 0 0.25 1" restart="whenNotActive" />
        )}
      </circle>
    </svg>
  );
}
