"use client";

import dynamic from "next/dynamic";

/** The 3D deck, loaded only in the browser and only when it is wanted
 *  (useDeckMode fetches its code first, so the CSS deck stands in until
 *  it is here and the swap is immediate). */
const Deck3D = dynamic(() => import("./PanelDeck"), { ssr: false, loading: () => null });

export default Deck3D;
