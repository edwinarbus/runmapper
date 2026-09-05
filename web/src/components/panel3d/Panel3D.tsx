"use client";

import dynamic from "next/dynamic";
import { Suspense, useCallback, useEffect, useState } from "react";
import PanelCss from "./PanelCss";

// The scene and three.js load only here, and only once the device has shown
// it can draw WebGL; until then, and instead on a device that cannot, the
// CSS panel stands in.
const Scene = dynamic(() => import("./Scene"), { ssr: false, loading: () => <PanelCss /> });

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function Panel3D() {
  const [mode, setMode] = useState<"deciding" | "3d" | "css">("deciding");
  useEffect(() => {
    // Decided once the page is up, off the render: ?css=1 asks for the CSS panel outright.
    const t = setTimeout(() => {
      const forced = new URLSearchParams(window.location.search).get("css") === "1";
      setMode(!forced && hasWebGL() ? "3d" : "css");
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const onSlow = useCallback(() => setMode("css"), []);
  if (mode !== "3d") return <PanelCss />;
  return (
    <Suspense fallback={<PanelCss />}>
      <Scene onSlow={onSlow} />
    </Suspense>
  );
}
