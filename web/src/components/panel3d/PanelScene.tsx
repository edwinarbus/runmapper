"use client";

import { ContactShadows, Environment, PerformanceMonitor } from "@react-three/drei";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { ACESFilmicToneMapping, MathUtils, type PerspectiveCamera } from "three";
import { usePrefersReducedMotion } from "./motion";
import { Tilt } from "./Tilt";

/** Keeps a part that fails to load (the studio map, on a bad connection)
 *  from taking the scene down with it: the panel just has less to reflect.
 *  The map is drei's "studio" preset, served from here rather than a CDN. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Backs the camera off until `widthCm` of the panel's face (at z = 0)
 *  fills the canvas side to side, whatever the canvas's shape; done on the
 *  next frame after a resize. Nearly head-on: a narrow field of view from
 *  far away keeps the plates true. */
function Fit({ widthCm }: { widthCm: number }) {
  const size = useThree((s) => s.size);
  const fitted = useRef("");
  useEffect(() => {
    invalidate();   // a resize asks for a frame, where the fit happens
  }, [size, widthCm]);
  useFrame(({ camera }) => {
    const key = `${size.width}x${size.height}x${widthCm}`;
    if (fitted.current === key) return;
    fitted.current = key;
    const cam = camera as PerspectiveCamera;
    const aspect = size.width / size.height;
    cam.position.z = widthCm / aspect / 2 / Math.tan(MathUtils.degToRad(cam.fov) / 2);
    cam.updateProjectionMatrix();
    invalidate();
  });
  return null;
}

/** Times the first frames after the scene is up. A device that cannot
 *  manage them gets the CSS panel instead. */
function Probe({ onSlow }: { onSlow: () => void }) {
  const times = useRef<number[]>([]);
  const started = useRef(0);
  useFrame((_, dt) => {
    if (!started.current) started.current = performance.now();
    if (times.current.length < 24 && performance.now() - started.current < 2500) {
      times.current.push(dt);
      invalidate();
    }
  });
  useEffect(() => {
    invalidate();
    const t = setTimeout(() => {
      const f = times.current.slice(4);   // the first few carry shader compiles
      if (f.length < 6) return;
      const avg = f.reduce((a, b) => a + b, 0) / f.length;
      if (avg > 1 / 14) onSlow();
    }, 2800);
    return () => clearTimeout(t);
  }, [onSlow]);
  return null;
}

/** The scene every panel sits in: a fixed camera fitted to the panel's
 *  width, one key light top left with a soft fill, the studio around it to
 *  reflect, a contact shadow under everything raised, and the panel leaning
 *  with the phone. Frames are drawn only when something changes; the pixel
 *  ratio is capped at 1.5 and lowered, with the reflections, on a device
 *  that struggles. */
export function PanelScene({
  widthCm,
  heightCm,
  shadowFar = 1.2,
  onSlow,
  children,
}: {
  widthCm: number;
  heightCm: number;
  shadowFar?: number;
  onSlow: () => void;
  children: ReactNode;
}) {
  const [dpr, setDpr] = useState(1.5);
  const [reflections, setReflections] = useState(true);
  const reduced = usePrefersReducedMotion();
  return (
    <Canvas
      frameloop="demand"
      dpr={dpr}
      camera={{ position: [0, 0, 60], fov: 18, near: 1, far: 400 }}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: true, stencil: false }}
      onCreated={({ gl }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 0.95;
      }}
      style={{ touchAction: "pan-y" }}
    >
      <PerformanceMonitor
        flipflops={2}
        onDecline={() => setDpr(1)}
        onIncline={() => setDpr(1.5)}
        onFallback={() => {
          setDpr(1);
          setReflections(false);
        }}
      />
      <Fit widthCm={widthCm} />
      <Probe onSlow={onSlow} />
      <ambientLight intensity={0.22} />
      <hemisphereLight args={["#eef2f7", "#26262b", 0.45]} />
      <directionalLight position={[-7, 9, 12]} intensity={1.7} color="#fff3e2" />
      <directionalLight position={[7, -3, 8]} intensity={0.55} color="#dde6ff" />
      {reflections && (
        <Quiet>
          <Suspense fallback={null}>
            <Environment files="/env/studio_small_03_1k.hdr" environmentIntensity={0.55} />
          </Suspense>
        </Quiet>
      )}
      <Tilt enabled={!reduced}>
        {children}
        {/* the shade every raised part throws on the plates, without a shadow map */}
        <ContactShadows position={[0, 0, 0.012]} rotation={[-Math.PI / 2, 0, 0]} scale={[widthCm, heightCm]} far={shadowFar} blur={2.2} opacity={0.5} frames={1} resolution={512} />
      </Tilt>
    </Canvas>
  );
}
