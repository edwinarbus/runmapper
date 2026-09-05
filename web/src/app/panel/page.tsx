import type { Metadata } from "next";
import Panel3D from "@/components/panel3d/Panel3D";

export const metadata: Metadata = {
  title: "Panel · drawmy.run",
  description: "A push-light on a plate, in WebGL.",
};

/** Stage one of the 3D panel: one annunciator on a plate with a screw in
 *  each corner. Tap the light; tilt the phone. ?css=1 shows the fallback. */
export default function PanelPage() {
  return (
    <main className="p3d-page">
      <div className="p3d-stage">
        <Panel3D />
      </div>
      <p className="p3d-hint">Tap the light. Tilt the phone.</p>
    </main>
  );
}
