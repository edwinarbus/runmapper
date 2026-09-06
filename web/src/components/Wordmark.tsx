import { useId } from "react";
import { WORDMARK_DOT, WORDMARK_OUTLINE_D, WORDMARK_VIEWBOX } from "@/lib/wordmark";

/** The wordmark: DRAWMYRUN as a run, the route in orange and the start dot
 *  green with its ring, sized by height. Etched, it is cut into the deck:
 *  the paint lies in a recess, a little darker for it, with the recess's
 *  upper wall shadowing its top edge inside and a line of the deck above,
 *  and the recess's lower lip catching the light below. Printed, it is
 *  simply the mark, as on the bib's paper. */
export default function Wordmark({ height, className, title = "drawmy.run", etched = false }: { height: number; className?: string; title?: string; etched?: boolean }) {
  const id = useId();
  const cut = `etch-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className={className} viewBox={WORDMARK_VIEWBOX} height={height} role="img" aria-label={title}>
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
            {/* the paint's own top edge in the wall's shadow, inside the cut */}
            <feOffset in="SourceAlpha" dy="0.38" result="down2" />
            <feComposite in="SourceAlpha" in2="down2" operator="out" result="shadeA" />
            <feGaussianBlur in="shadeA" stdDeviation="0.1" result="shadeB" />
            <feComposite in="shadeB" in2="SourceAlpha" operator="in" result="shadeC" />
            <feFlood floodColor="#000" floodOpacity="0.62" result="black2" />
            <feComposite in="black2" in2="shadeC" operator="in" result="shade" />
            <feMerge>
              <feMergeNode in="wall" />
              <feMergeNode in="lip" />
              <feMergeNode in="SourceGraphic" />
              <feMergeNode in="shade" />
            </feMerge>
          </filter>
        </defs>
      )}
      <g filter={etched ? `url(#${cut})` : undefined}>
        <path d={WORDMARK_OUTLINE_D} fill={etched ? "#e84e02" : "#fc5200"} fillRule="evenodd" />
        <circle cx={WORDMARK_DOT.x} cy={WORDMARK_DOT.y} r={WORDMARK_DOT.r} fill={etched ? "#11a97b" : "#12b886"} stroke={etched ? "#e6e2d8" : "#f6f3ec"} strokeWidth={0.22} />
      </g>
    </svg>
  );
}
