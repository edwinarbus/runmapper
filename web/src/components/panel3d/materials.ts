import * as THREE from "three";

// One of each material and geometry, shared by every control that uses it.
// Made on first use, in the browser only (the scene never renders on the server).

export interface Materials {
  /** The plate: matte painted grey, with a little noise in its roughness. */
  paint: THREE.MeshStandardMaterial;
  /** Screw heads, toggle bats, nuts: chrome, reflecting the studio around it. */
  chrome: THREE.MeshStandardMaterial;
  /** Bezels and knobs: black matte plastic. */
  plastic: THREE.MeshStandardMaterial;
  /** An unlit annunciator cap: dark amber glass. */
  lensOff: THREE.MeshPhysicalMaterial;
  /** A lit one: amber, and a light of its own. */
  lensOn: THREE.MeshPhysicalMaterial;
  /** A lit green cap. */
  lensGreen: THREE.MeshPhysicalMaterial;
  /** A lit red cap. */
  lensRed: THREE.MeshPhysicalMaterial;
  /** A lit white cap. */
  lensWhite: THREE.MeshPhysicalMaterial;
  /** The dark cut of a screw's cross, and the recess it sits in. */
  cut: THREE.MeshStandardMaterial;
  /** The red guard over a switch. */
  guard: THREE.MeshStandardMaterial;
  /** A gauge's face. */
  face: THREE.MeshStandardMaterial;
  /** A gauge's needle. */
  needle: THREE.MeshStandardMaterial;
  /** The dark glass over an LED window. */
  glass: THREE.MeshPhysicalMaterial;
  /** LED segments: lit by their own instance colours, untouched by the lights. */
  led: THREE.MeshBasicMaterial;
  /** The pointer line on a knob. */
  mark: THREE.MeshStandardMaterial;
  /** The invisible, oversized target behind each control. Draws nothing. */
  hit: THREE.MeshBasicMaterial;
}

export interface Geometries {
  screwSeat: THREE.CylinderGeometry;
  screwHead: THREE.CylinderGeometry;
  screwCross: THREE.BoxGeometry;
  unit: THREE.BoxGeometry;
  nut: THREE.CylinderGeometry;
  bushing: THREE.CylinderGeometry;
  lever: THREE.CylinderGeometry;
  ball: THREE.SphereGeometry;
  knob: THREE.CylinderGeometry;
  knobTop: THREE.CylinderGeometry;
  knobSkirt: THREE.CylinderGeometry;
  gaugeBezel: THREE.CylinderGeometry;
  gaugeFace: THREE.CylinderGeometry;
  gaugeCap: THREE.CylinderGeometry;
}

let materials: Materials | null = null;
let geometries: Geometries | null = null;

/** Value noise in a small tile, for a painted surface's roughness: a coarse
 *  grain, a finer one, and a speckle. Mid grey is the base roughness. */
function noiseTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const grid = (cell: number) => {
    const n = Math.ceil(size / cell) + 1;
    const g = Array.from({ length: n * n }, () => Math.random());
    return (x: number, y: number) => {
      const gx = x / cell, gy = y / cell;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const tx = gx - x0, ty = gy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => g[((j % n) + n) % n * n + (((i % n) + n) % n)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const coarse = grid(32), fine = grid(8);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 0.5 + (coarse(x, y) - 0.5) * 0.35 + (fine(x, y) - 0.5) * 0.25 + (Math.random() - 0.5) * 0.12;
      const byte = Math.max(0, Math.min(255, Math.round(v * 255)));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = byte;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function alongZ<T extends THREE.BufferGeometry>(g: T): T {
  g.rotateX(Math.PI / 2);   // a cylinder's axis along z, out of the plate
  return g;
}

const lens = (color: string, emissive: string, intensity: number) =>
  new THREE.MeshPhysicalMaterial({ color, emissive, emissiveIntensity: intensity, roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25 });

export function getMaterials(): Materials {
  if (materials) return materials;
  const rough = noiseTexture();
  materials = {
    paint: new THREE.MeshStandardMaterial({ color: "#878c90", roughness: 0.82, metalness: 0.05, roughnessMap: rough, bumpMap: rough, bumpScale: 0.004 }),
    chrome: new THREE.MeshStandardMaterial({ color: "#e6e8ea", roughness: 0.18, metalness: 1 }),
    plastic: new THREE.MeshStandardMaterial({ color: "#151517", roughness: 0.7, metalness: 0.05 }),
    lensOff: new THREE.MeshPhysicalMaterial({ color: "#2b2214", roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
    lensOn: lens("#9a5200", "#ff8c00", 1.05),
    lensGreen: lens("#1c6b32", "#2bff6a", 0.85),
    lensRed: lens("#7a0f12", "#ff2a2a", 1.0),
    lensWhite: lens("#b8b4a8", "#fff3d6", 0.9),
    cut: new THREE.MeshStandardMaterial({ color: "#26282a", roughness: 0.6, metalness: 0.4 }),
    guard: new THREE.MeshStandardMaterial({ color: "#c41a2b", roughness: 0.5, metalness: 0.05 }),
    face: new THREE.MeshStandardMaterial({ color: "#f1efe8", roughness: 0.85, metalness: 0 }),
    needle: new THREE.MeshStandardMaterial({ color: "#e0301e", roughness: 0.6, metalness: 0.1 }),
    glass: new THREE.MeshPhysicalMaterial({ color: "#050807", roughness: 0.12, metalness: 0, transparent: true, opacity: 0.32, clearcoat: 1, clearcoatRoughness: 0.15, depthWrite: false }),
    led: new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
    mark: new THREE.MeshStandardMaterial({ color: "#f4f2ec", roughness: 0.6, metalness: 0 }),
    hit: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 }),
  };
  return materials;
}

export function getGeometries(): Geometries {
  if (geometries) return geometries;
  geometries = {
    screwSeat: alongZ(new THREE.CylinderGeometry(0.34, 0.34, 0.02, 28)),
    screwHead: alongZ(new THREE.CylinderGeometry(0.27, 0.31, 0.12, 28)),
    screwCross: new THREE.BoxGeometry(0.36, 0.075, 0.03),
    unit: new THREE.BoxGeometry(1, 1, 1),
    nut: alongZ(new THREE.CylinderGeometry(0.46, 0.46, 0.16, 6)),
    bushing: alongZ(new THREE.CylinderGeometry(0.3, 0.3, 0.26, 24)),
    lever: new THREE.CylinderGeometry(0.075, 0.1, 1.25, 16),
    ball: new THREE.SphereGeometry(0.24, 20, 14),
    knob: alongZ(new THREE.CylinderGeometry(0.82, 0.9, 0.55, 40)),
    knobTop: alongZ(new THREE.CylinderGeometry(0.62, 0.72, 0.16, 40)),
    knobSkirt: alongZ(new THREE.CylinderGeometry(1.15, 1.15, 0.04, 48)),
    gaugeBezel: alongZ(new THREE.CylinderGeometry(1.7, 1.75, 0.35, 48)),
    gaugeFace: alongZ(new THREE.CylinderGeometry(1.5, 1.5, 0.04, 48)),
    gaugeCap: alongZ(new THREE.CylinderGeometry(0.14, 0.14, 0.08, 16)),
  };
  return geometries;
}
