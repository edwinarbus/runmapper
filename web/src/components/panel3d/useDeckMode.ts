"use client";

import { useCallback, useEffect, useState } from "react";

export type DeckMode = "deciding" | "3d" | "css";

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Which deck to show: the WebGL panel once its code has arrived and the
 *  device can draw it, the CSS deck until then and instead where it cannot.
 *  ?css=1 asks for the CSS deck outright; ?css=0 insists on the panel. A
 *  device that turned out too slow is remembered for the session. */
export function useDeckMode(): { deck: DeckMode; onSlow: () => void } {
  const [deck, setDeck] = useState<DeckMode>("deciding");
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      const q = new URLSearchParams(window.location.search);
      let remembered = "";
      try {
        remembered = sessionStorage.getItem("deck") ?? "";
      } catch {
        /* no storage */
      }
      const off = q.get("css") === "1" || (remembered === "css" && q.get("css") !== "0");
      if (off || !hasWebGL()) {
        setDeck("css");
        return;
      }
      // Fetch the panel's code now; the CSS deck stands in until it is here.
      import("./PanelDeck").then(
        () => live && setDeck("3d"),
        () => live && setDeck("css"),
      );
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, []);
  const onSlow = useCallback(() => {
    try {
      sessionStorage.setItem("deck", "css");
    } catch {
      /* no storage */
    }
    setDeck("css");
  }, []);
  return { deck, onSlow };
}
