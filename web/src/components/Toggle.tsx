import { useId } from "react";

// A panel toggle switch, the metal kind: a knurled ring nut round a bushing
// set into the deck, and a chrome bat lever on a ball joint that leans to
// one side or the other. Drawn as a vector so the chrome, the knurling and
// the lever's cast shadow are real gradients and blurs at any size. The
// lever's lean is set by the button around it (see .switch in globals.css),
// which is what carries the state.
export default function Toggle() {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="toggle" viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        {/* the nut: turned steel, lit from the top left */}
        <linearGradient id={`${id}-nut`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f7f7f9" />
          <stop offset="0.3" stopColor="#a6a6b0" />
          <stop offset="0.48" stopColor="#dedee3" />
          <stop offset="0.66" stopColor="#7a7a85" />
          <stop offset="1" stopColor="#3d3d45" />
        </linearGradient>
        <linearGradient id={`${id}-nut2`} x1="1" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#c9c9d0" />
          <stop offset="0.5" stopColor="#6a6a74" />
          <stop offset="1" stopColor="#2e2e35" />
        </linearGradient>
        {/* the bushing's mouth: black, a thread of light on its far rim */}
        <radialGradient id={`${id}-socket`} cx="50%" cy="42%" r="56%">
          <stop offset="0" stopColor="#020203" />
          <stop offset="0.72" stopColor="#0a0a0d" />
          <stop offset="1" stopColor="#35353d" />
        </radialGradient>
        {/* the lever: chrome, a bright band left of centre, dark at the edges */}
        <linearGradient id={`${id}-lever`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#4a4a53" />
          <stop offset="0.22" stopColor="#c9c9d1" />
          <stop offset="0.38" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#b9b9c2" />
          <stop offset="0.82" stopColor="#6f6f79" />
          <stop offset="1" stopColor="#35353c" />
        </linearGradient>
        <radialGradient id={`${id}-tip`} cx="36%" cy="30%" r="68%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.42" stopColor="#d3d3da" />
          <stop offset="0.8" stopColor="#7c7c87" />
          <stop offset="1" stopColor="#40404a" />
        </radialGradient>
        <radialGradient id={`${id}-ball`} cx="38%" cy="32%" r="64%">
          <stop offset="0" stopColor="#f2f2f5" />
          <stop offset="0.55" stopColor="#9c9ca6" />
          <stop offset="1" stopColor="#3b3b43" />
        </radialGradient>
        <filter id={`${id}-soft`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
        <filter id={`${id}-softer`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      {/* the nut's seat on the deck */}
      <circle cx="24" cy="31" r="16.5" fill="#000" opacity="0.6" filter={`url(#${id}-softer)`} />
      <circle cx="24" cy="29" r="16" fill={`url(#${id}-nut)`} />
      {/* the knurl: a ring of grooves round the nut's edge */}
      <circle cx="24" cy="29" r="14.6" fill="none" stroke="#1a1a1f" strokeWidth="2.6" strokeDasharray="1.1 1.35" opacity="0.55" />
      <circle cx="24" cy="29" r="14.6" fill="none" stroke="#fff" strokeWidth="2.6" strokeDasharray="1.1 1.35" strokeDashoffset="0.6" opacity="0.18" />
      {/* the nut's inner face, turned, and the bushing */}
      <circle cx="24" cy="29" r="12.6" fill={`url(#${id}-nut2)`} />
      <circle cx="24" cy="29" r="12.6" fill="none" stroke="#000" strokeWidth="0.6" opacity="0.5" />
      <circle cx="24" cy="29" r="10.4" fill={`url(#${id}-socket)`} />
      <circle cx="24" cy="29" r="10.4" fill="none" stroke="#000" strokeWidth="1.2" opacity="0.7" />
      {/* the lever's shadow, thrown down and to the right across the nut */}
      <g className="toggle-shadow">
        <path d="M21.9 29 L19.6 12.6 Q24 6.8 28.4 12.6 L26.1 29 Z" fill="#000" opacity="0.5" filter={`url(#${id}-soft)`} transform="translate(1.8 2.6)" />
      </g>
      {/* the lever itself: a bat handle, narrow at the ball, full at the tip */}
      <g className="toggle-lever">
        <path d="M21.9 29 L19.6 12.6 Q24 6.8 28.4 12.6 L26.1 29 Z" fill={`url(#${id}-lever)`} />
        <path d="M21.9 29 L19.6 12.6 Q24 6.8 28.4 12.6 L26.1 29 Z" fill="none" stroke="#1d1d22" strokeWidth="0.5" opacity="0.6" />
        <ellipse cx="24" cy="11.6" rx="4.5" ry="4" fill={`url(#${id}-tip)`} />
        <path d="M22.3 15 L21.6 26.5" stroke="#fff" strokeWidth="0.9" strokeLinecap="round" opacity="0.6" />
        <circle cx="24" cy="29" r="4.8" fill={`url(#${id}-ball)`} />
        <circle cx="24" cy="29" r="4.8" fill="none" stroke="#000" strokeWidth="0.5" opacity="0.45" />
      </g>
    </svg>
  );
}
