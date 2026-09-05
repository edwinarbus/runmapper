"use client";

import { useState } from "react";

/** The same plate and push-light in CSS, for a device without WebGL or one
 *  that cannot keep up with it. */
export default function PanelCss() {
  const [lit, setLit] = useState(false);
  return (
    <div className="p3d-css" role="group" aria-label="Panel">
      <div className="p3d-plate">
        <span className="p3d-screw" style={{ top: 10, left: 10 }} />
        <span className="p3d-screw" style={{ top: 10, right: 10 }} />
        <span className="p3d-screw" style={{ bottom: 10, left: 10 }} />
        <span className="p3d-screw" style={{ bottom: 10, right: 10 }} />
        <div className="p3d-label">PANEL LIGHT</div>
        <button
          type="button"
          className="p3d-ann"
          aria-pressed={lit}
          onClick={() => {
            setLit((v) => !v);
            navigator.vibrate?.(10);
          }}
        >
          {lit ? "ON" : "OFF"}
        </button>
        <div className="p3d-label p3d-label-small">PUSH</div>
      </div>
    </div>
  );
}
