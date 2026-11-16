#!/usr/bin/env node
// Headless checks of WindowModel against a cfg GLB (default public/Window_V3_cfg.glb).
//   node tools/test-deform.mjs [path.glb]
// Checks joints stay closed, mitres stay rigid, reset is bit-exact, animation travel scales,
// and colour zones are independent.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { loadGltf, WindowModel, ConfigError } from '../src/configurator/WindowModel.js';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || resolve(here, '../public/Window_V3_cfg.glb');
const buf = readFileSync(file);
const gltf = await loadGltf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

let model;
try { model = new WindowModel(gltf); }
catch (e) { if (e instanceof ConfigError) { console.log(e.message); e.errors.forEach((x) => console.log('  ' + x)); process.exit(1); } throw e; }

const W0 = model.ref.width_m, H0 = model.ref.height_m;
const part = (name) => model.parts.find((p) => p.name === name);
const box = (name) => {
  const b = new THREE.Box3();
  for (const { mesh } of part(name).meshes) { mesh.geometry.computeBoundingBox(); b.union(mesh.geometry.boundingBox); }
  return b;
};
const refBoxes = Object.fromEntries(model.parts.map((p) => [p.name, box(p.name)]));
const rootBox = () => { model.root.updateMatrixWorld(true); return new THREE.Box3().setFromObject(model.root); };

console.log(`file: ${file}`);
console.log(`parts: ${model.parts.length}, clips: ${model.clips.map((c) => c.clip.name).join(', ')}, faceSplit: ${model.hasFaceSplit}`);
console.log(`geometric limits: min W ${(model.limits.minWidth_m / 0.0254).toFixed(2)} in, min H ${(model.limits.minHeight_m / 0.0254).toFixed(2)} in`);

const cases = [
  { W: W0 + 0.3, H: H0 + 0.2, label: 'grow (+300 mm W, +200 mm H)' },
  { W: W0 - 0.2, H: H0 - 0.3, label: 'shrink (-200 mm W, -300 mm H)' },
  { W: 48 * 0.0254, H: 72 * 0.0254, label: '48 x 72 in' },
  { W: model.limits.minWidth_m + 0.01, H: model.limits.minHeight_m + 0.01, label: 'near geometric minimum' },
];

for (const c of cases) {
  console.log(`case: ${c.label}`);
  model.setSize(c.W, c.H);
  const dW = c.W - W0, dH = c.H - H0;
  const rb = rootBox();
  check(near(rb.min.x, 0) && near(rb.max.x, c.W), `outer width ${rb.max.x - rb.min.x} != ${c.W}`);
  check(near(rb.min.y, 0) && near(rb.max.y, c.H), `outer height ${rb.max.y - rb.min.y} != ${c.H}`);

  // Each part: bbox moves/grows exactly as its cfg says, depth untouched, nothing inverted.
  for (const p of model.parts) {
    const r = refBoxes[p.name], b = box(p.name), { x, y } = p.cfg;
    const expMinX = r.min.x + dW * (r.min.x < x.split_m ? x.below : x.above);
    const expMaxX = r.max.x + dW * (r.max.x < x.split_m ? x.below : x.above);
    const expMinY = r.min.y + dH * (r.min.y < y.split_m ? y.below : y.above);
    const expMaxY = r.max.y + dH * (r.max.y < y.split_m ? y.below : y.above);
    check(near(b.min.x, expMinX) && near(b.max.x, expMaxX), `${p.name} x-range [${b.min.x},${b.max.x}] expected [${expMinX},${expMaxX}]`);
    check(near(b.min.y, expMinY) && near(b.max.y, expMaxY), `${p.name} y-range`);
    check(near(b.min.z, r.min.z, 0) && near(b.max.z, r.max.z, 0), `${p.name} depth changed`);
    check(b.max.x > b.min.x && b.max.y > b.min.y, `${p.name} inverted`);
  }

  // Joints that must stay closed.
  check(near(box('Frame_Right_09440I').max.x, c.W), 'frame right edge at W');
  check(near(box('Frame_Top_09440I').max.y, c.H), 'frame top edge at H');
  check(near(box('Frame_Left_09440I').max.y, box('Frame_Top_09440I').max.y), 'frame left jamb meets head');
  check(near(box('LowerSash_Top_09823').max.y, box('UpperSash_Bottom_09824').max.y), 'meeting rails aligned');
  check(near(box('LowerSash_Left_09822').max.y, box('LowerSash_Top_09823').max.y), 'lower sash stile meets top rail');
  check(near(box('UpperSash_Left_09822').max.y, box('UpperSash_Top_09825').max.y), 'upper sash stile meets top rail');
  check(near(box('LowerGlass').max.x - box('LowerGlass').min.x, refBoxes.LowerGlass.max.x - refBoxes.LowerGlass.min.x + dW), 'lower glass width grows by dW');

  // Mitre rigidity: within each vertex set (below / above split), pairwise offsets equal the reference.
  const fb = part('Frame_Bottom_09440I').meshes[0];
  const pos = fb.mesh.geometry.getAttribute('position').array, ref = fb.ref;
  let rigid = true;
  for (let i = 0; i < ref.length; i += 3) {
    const shift = ref[i] < 0.3048 ? 0 : dW;
    if (Math.abs(pos[i] - ref[i] - shift) > 1e-6 || pos[i + 1] !== ref[i + 1] || pos[i + 2] !== ref[i + 2]) { rigid = false; break; }
  }
  check(rigid, 'Frame_Bottom mitre ends translate rigidly');

  // Animation travel.
  for (const cl of model.clips) {
    const k = { x: 0, y: 1, z: 2 }[cl.cfg.axis];
    let peak = 0;
    for (let i = k; i < cl.track.values.length; i += 3) peak = Math.max(peak, Math.abs(cl.track.values[i]));
    const expected = cl.cfg.referenceTravel_m + cl.cfg.travelPerDeltaHeight * dH;
    check(Math.abs(peak - expected) < 2e-4, `${cl.clip.name} travel ${peak.toFixed(4)} expected ${expected.toFixed(4)}`);
  }
}

// Reset must be bit-exact (no accumulated drift after many edits).
for (let i = 0; i < 50; i++) model.setSize(W0 + Math.sin(i) * 0.3, H0 + Math.cos(i) * 0.3);
model.setSize(W0, H0);
let exact = true;
for (const p of model.parts) for (const { mesh, ref } of p.meshes) {
  const a = mesh.geometry.getAttribute('position').array;
  for (let i = 0; i < a.length; i++) if (a[i] !== ref[i]) { exact = false; break; }
}
check(exact, 'reset to reference size is bit-exact after 50 edits');
check(model.clips.every((c) => c.track.values.every((v, i) => v === c.refValues[i])), 'animation keyframes restored exactly');

// Below the geometric limit must throw, not render inverted geometry.
let threw = false;
try { model.setSize(model.limits.minWidth_m - 0.01, H0); } catch { threw = true; }
check(threw, 'setSize below geometric limit throws');

// Colour zones are independent.
model.setZoneColor('exterior', '#ff0000');
model.setZoneColor('interior', '#0000ff');
const colorOf = (name) => part(name).meshes[0].mesh.material.color.getHexString();
if (!model.hasFaceSplit) {
  check(colorOf('Frame_Bottom_09440I') === 'ff0000', 'frame follows exterior colour');
  check(colorOf('LowerSash_Bottom_09825') === '0000ff', 'lower sash follows interior colour');
} else {
  const zones = new Set(model.parts.flatMap((p) => p.meshes.map((m) => m.mesh.material.color.getHexString())));
  check(zones.has('ff0000') && zones.has('0000ff'), 'both colour zones in use');
}
check(colorOf('LowerGlass') !== 'ff0000' && colorOf('LowerSash_Bottom_09825_tape') !== 'ff0000', 'glass/gasket not recoloured');

// Playback smoke test.
model.play(null);
model.update(2.5);
const lowerY = model.scene.getObjectByName('LowerSash_Moving').position.y;
check(lowerY > 0.3, `lower sash raised during playback (y=${lowerY.toFixed(4)})`);

console.log(failures ? `FAILED: ${failures} failed, ${passes} passed` : `OK: ${passes} checks passed`);
process.exit(failures ? 1 : 0);
