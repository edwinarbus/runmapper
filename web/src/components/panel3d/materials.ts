import * as THREE from "three";

// One of each material and geometry, shared by every control that uses it.
// Made on first use, in the browser only (the scene never renders on the server).

export interface Materials {
  /** The plate: matte painted grey, with a little noise in its roughness. */
  paint: THREE.MeshStandardMaterial;
  /** Screw heads and toggle bats: chrome, reflecting the studio around it. */
  chrome: THREE.MeshStandardMaterial;
  /** Bezels and knobs: black matte plastic. */
  plastic: THREE.MeshStandardMaterial;
  /** An unlit annunciator cap: dark amber glass. */
  lensOff: THREE.MeshPhysicalMaterial;
  /** A lit one: amber, and a light of its own. */
  lensOn: THREE.MeshPhysicalMaterial;
  /** The dark cut of a screw's cross, and the recess it sits in. */
  cut: THREE.MeshStandardMaterial;
  /** The invisible, oversized target behind each control. Draws nothing. */
  hit: THREE.MeshBasicMaterial;
}

export interface Geometries {
  screwSeat: THREE.CylinderGeometry;
  screwHead: THREE.CylinderGeometry;
  screwCross: THREE.BoxGeometry;
  annBezel: THREE.BoxGeometry;
  annCap: THREE.BoxGeometry;
  annHit: THREE.BoxGeometry;
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

function tuneZ(g: THREE.CylinderGeometry): THREE.CylinderGeometry {
  g.rotateX(Math.PI / 2);   // the cylinder's axis along z, out of the plate
  return g;
}

export function getMaterials(): Materials {
  if (materials) return materials;
  const rough = noiseTexture();
  materials = {
    paint: new THREE.MeshStandardMaterial({ color: "#878c90", roughness: 0.82, metalness: 0.05, roughnessMap: rough, bumpMap: rough, bumpScale: 0.004 }),
    chrome: new THREE.MeshStandardMaterial({ color: "#e6e8ea", roughness: 0.18, metalness: 1 }),
    plastic: new THREE.MeshStandardMaterial({ color: "#151517", roughness: 0.7, metalness: 0.05 }),
    lensOff: new THREE.MeshPhysicalMaterial({ color: "#2b2214", roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
    lensOn: new THREE.MeshPhysicalMaterial({ color: "#9a5200", emissive: "#ff8c00", emissiveIntensity: 1.05, roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.25 }),
    cut: new THREE.MeshStandardMaterial({ color: "#26282a", roughness: 0.6, metalness: 0.4 }),
    hit: new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 }),
  };
  return materials;
}

export function getGeometries(): Geometries {
  if (geometries) return geometries;
  geometries = {
    screwSeat: tuneZ(new THREE.CylinderGeometry(0.34, 0.34, 0.02, 28)),
    screwHead: tuneZ(new THREE.CylinderGeometry(0.27, 0.31, 0.12, 28)),
    screwCross: new THREE.BoxGeometry(0.36, 0.075, 0.03),
    annBezel: new THREE.BoxGeometry(2.6, 1.8, 0.3),
    annCap: new THREE.BoxGeometry(2.2, 1.4, 0.32),
    annHit: new THREE.BoxGeometry(3.2, 2.4, 0.9),
  };
  return geometries;
}
