"use client";

import { ContactShadows, Environment, PerformanceMonitor } from "@react-three/drei";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { ACESFilmicToneMapping, MathUtils, type PerspectiveCamera } from "three";
import { Annunciator } from "./Annunciator";
import { usePrefersReducedMotion } from "./motion";
import { Plate, PlateLabel } from "./Plate";
import { Screw } from "./Screw";
import { Tilt } from "./Tilt";

const PLATE = { w: 9, h: 6.4 };   // centimetres

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

/** Backs the camera off until the plate fits the canvas, whatever its
 *  shape; done on the next frame after a resize. */
function Fit() {
  const size = useThree((s) => s.size);
  const fitted = useRef("");
  useEffect(() => {
    invalidate();   // a resize asks for a frame, where the fit happens
  }, [size]);
  useFrame(({ camera }) => {
    const key = `${size.width}x${size.height}`;
    if (fitted.current === key) return;
    fitted.current = key;
    const cam = camera as PerspectiveCamera;
    const aspect = size.width / size.height;
    const need = Math.max(PLATE.h + 1.6, (PLATE.w + 1.2) / aspect);
    cam.position.z = need / 2 / Math.tan(MathUtils.degToRad(cam.fov) / 2);
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

export default function Scene({ onSlow }: { onSlow: () => void }) {
  const [dpr, setDpr] = useState(1.5);
  const [reflections, setReflections] = useState(true);
  const [lit, setLit] = useState(false);
  const reduced = usePrefersReducedMotion();
  return (
    <Canvas
      frameloop="demand"
      dpr={dpr}
      camera={{ position: [0, 0, 18], fov: 26, near: 1, far: 100 }}
      gl={{ antialias: true, powerPreference: "high-performance", alpha: true, stencil: false }}
      onCreated={({ gl }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 0.95;
      }}
      style={{ touchAction: "none" }}
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
      <Fit />
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
        <Plate w={PLATE.w} h={PLATE.h}>
          <Screw position={[-PLATE.w / 2 + 0.55, PLATE.h / 2 - 0.55, 0]} turn={0.4} />
          <Screw position={[PLATE.w / 2 - 0.55, PLATE.h / 2 - 0.55, 0]} turn={-0.7} />
          <Screw position={[-PLATE.w / 2 + 0.55, -PLATE.h / 2 + 0.55, 0]} turn={1.2} />
          <Screw position={[PLATE.w / 2 - 0.55, -PLATE.h / 2 + 0.55, 0]} turn={-0.2} />
          <PlateLabel position={[0, 1.75, 0.01]} size={0.4}>
            PANEL LIGHT
          </PlateLabel>
          <Annunciator position={[0, 0.15, 0]} label={lit ? "ON" : "OFF"} lit={lit} onToggle={() => setLit((v) => !v)} />
          <PlateLabel position={[0, -1.55, 0.01]} size={0.3}>
            PUSH
          </PlateLabel>
          {/* the shade every raised part throws on the plate, without a shadow map */}
          <ContactShadows position={[0, 0, 0.012]} rotation={[-Math.PI / 2, 0, 0]} scale={[PLATE.w, PLATE.h]} far={1.2} blur={2.2} opacity={0.55} frames={1} resolution={512} />
        </Plate>
      </Tilt>
    </Canvas>
  );
}
