import { useId, useRef } from "react";
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
  const go = () => {
    const m = motion.current as (SVGAnimateMotionElement & { beginElement?: () => void }) | null;
    m?.beginElement?.();
  };
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
      <circle cx={WORDMARK_DOT.x} cy={WORDMARK_DOT.y} r={WORDMARK_DOT.r} fill="#12b886" stroke="#f6f3ec" strokeWidth={0.22} filter={etched ? `url(#lamp-${id})` : undefined}>
        {run && (
          /* the run: along the route through DRAWMY (in the dot's own frame, so it ends where it stands), easing off the line and back onto it */
          <animateMotion ref={motion} path={WORDMARK_DOT_RUN} begin="indefinite" dur="2.6s" calcMode="spline" keyTimes="0;1" keySplines="0.35 0 0.25 1" restart="whenNotActive" />
        )}
      </circle>
    </svg>
  );
}
