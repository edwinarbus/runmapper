import { WORDMARK_DOT, WORDMARK_OUTLINE_D, WORDMARK_VIEWBOX } from "@/lib/wordmark";

/** The wordmark: DRAWMYRUN as a run, the route in orange and the start dot
 *  green with its ring, sized by height. */
export default function Wordmark({ height, className, title = "drawmy.run" }: { height: number; className?: string; title?: string }) {
  return (
    <svg className={className} viewBox={WORDMARK_VIEWBOX} height={height} role="img" aria-label={title}>
      <path d={WORDMARK_OUTLINE_D} fill="#fc5200" fillRule="evenodd" />
      <circle cx={WORDMARK_DOT.x} cy={WORDMARK_DOT.y} r={WORDMARK_DOT.r} fill="#12b886" stroke="#f6f3ec" strokeWidth={0.22} />
    </svg>
  );
}
