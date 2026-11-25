#!/usr/bin/env node
// Collision sweep for a configurator GLB: how deep do moving parts go into fixed parts while the sash opens?
//   node tools/sweep-collisions.mjs <cfg.glb> [--steps 20] [--size <width_in> <height_in>] [--fail-mm <depth>]
//
// Moving parts = parts below a hinge pivot or motion group. Fixed parts = all others (frame, extension, tracks, ...).
// Every opening clip plays together (as the panel's "Both"); each moving vertex is tested for being inside each fixed
// part (ray parity over all of that part's primitives, double-sided), and its depth is the distance to that part's
// nearest triangle. Step 0 is the closed pose: overlaps there are seal/gasket contact drawn in the source, and are
// listed but never fail the run. With --fail-mm, the exit code is 1 if any open-pose depth exceeds that value.
// VISUAL QA ONLY: this measures the preview geometry, never product clearances.

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { loadGltf, WindowModel, ConfigError } from '../src/configurator/WindowModel.js';
import { GROUP_SCHEMA, HINGE_SCHEMA } from '../src/configurator/schema.js';
import { inToM } from '../src/configurator/deform.js';

const args = process.argv.slice(2);
const file = args[0];
const opt = (name, n = 1) => { const i = args.indexOf(name); return i < 0 ? null : args.slice(i + 1, i + 1 + n).map(Number); };
const steps = opt('--steps')?.[0] ?? 20;
const size = opt('--size', 2);
const failMm = opt('--fail-mm')?.[0] ?? null;
if (!file || file.startsWith('--') || !(steps >= 1) || (size && size.some((v) => !(v > 0))) || (failMm !== null && !(failMm >= 0))) {
  console.error('usage: sweep-collisions.mjs <cfg.glb> [--steps N] [--size <width_in> <height_in>] [--fail-mm <depth>]');
  process.exit(2);
}

const buf = readFileSync(file);
let m;
try { m = new WindowModel(await loadGltf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))); }
catch (e) { console.log(e.message); (e instanceof ConfigError ? e.errors : []).forEach((x) => console.log(`  ${x}`)); process.exit(1); }
if (size) m.setSize(inToM(size[0]), inToM(size[1])); // throws (blocked, not clamped) below the geometric limit

const isAnimated = (o) => [GROUP_SCHEMA, HINGE_SCHEMA].includes(o.userData?.cfg?.schema);
const moves = (p) => { for (let o = p.object.parent; o; o = o.parent) if (isAnimated(o)) return true; return false; };
const moving = m.parts.filter(moves);
const fixed = m.parts.filter((p) => !moves(p));
const opening = m.clips.filter((c) => c.direction !== 'close');
if (!moving.length || !opening.length) { console.log('No moving parts or no opening clip: nothing to sweep.'); process.exit(0); }

// Fixed parts never move: their triangles are taken once, in model space. Raycasts must see back faces for parity.
m.scene.updateMatrixWorld(true);
const dbl = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const partOf = new Map(), fixedMeshes = [], tris = new Map();
for (const p of fixed) {
  const list = [];
  for (const { mesh } of p.meshes) {
    mesh.material = dbl; // this script's own copy of the model; nothing is written back
    partOf.set(mesh, p);
    fixedMeshes.push(mesh);
    const pos = mesh.geometry.getAttribute('position');
    const idx = mesh.geometry.index ? mesh.geometry.index.array : Array.from({ length: pos.count }, (_, i) => i);
    for (let t = 0; t < idx.length; t += 3) list.push(new THREE.Triangle(...[0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, idx[t + k]).applyMatrix4(mesh.matrixWorld))));
  }
  tris.set(p, list);
}
const q = new THREE.Vector3();
const depthIn = (v, p) => { let d = Infinity; for (const t of tris.get(p)) { t.closestPointToPoint(v, q); d = Math.min(d, q.distanceToSquared(v)); } return Math.sqrt(d); };
const ray = new THREE.Raycaster();
const dir = new THREE.Vector3(1, 0.0123, 0.0071).normalize(); // off-axis, so rays do not run along edges

const duration = Math.max(...opening.map((c) => c.clip.duration));
const worst = new Map(); // "moving in fixed" -> { closed, open, steps:Set }
const v = new THREE.Vector3();
for (let s = 0; s <= steps; s++) {
  m.stop();
  if (s > 0) { m.play(null); m.update((duration * s) / steps); }
  m.scene.updateMatrixWorld(true);
  for (const p of moving) {
    for (const { mesh } of p.meshes) {
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        ray.set(v, dir);
        const per = new Map();
        for (const h of ray.intersectObjects(fixedMeshes, false)) { const o = partOf.get(h.object); per.set(o, (per.get(o) ?? 0) + 1); }
        for (const [o, n] of per) {
          if (n % 2 === 0) continue;
          const key = `${p.name} in ${o.name}`;
          const w = worst.get(key) ?? { closed: 0, open: 0, steps: new Set() };
          const d = depthIn(v, o);
          if (s === 0) w.closed = Math.max(w.closed, d); else w.open = Math.max(w.open, d);
          w.steps.add(s);
          worst.set(key, w);
        }
      }
    }
  }
}

const mm = (x) => (x * 1000).toFixed(2);
console.log(`Collision sweep ${file}`);
console.log(`  size ${(m.width_m / 0.0254).toFixed(3)} x ${(m.height_m / 0.0254).toFixed(3)} in, ${steps + 1} poses (0 = closed), clips: ${opening.map((c) => c.clip.name).join(', ')}`);
console.log(`  ${moving.length} moving parts vs ${fixed.length} fixed parts`);
if (!worst.size) console.log('  no moving vertex inside a fixed part at any pose');
// Vertices lying on another part's surface (shared faces, seals drawn touching) test as "inside" with depth ~0.
const TOUCH_M = 1e-5;
const all = [...worst].sort((a, b) => b[1].open - a[1].open || b[1].closed - a[1].closed);
const rows = all.filter(([, w]) => Math.max(w.open, w.closed) > TOUCH_M);
if (all.length > rows.length) console.log(`  ${all.length - rows.length} pair(s) only touching (<= ${TOUCH_M * 1000} mm), not listed`);
for (const [k, w] of rows) {
  const st = [...w.steps].sort((a, b) => a - b);
  console.log(`  ${k}: closed ${mm(w.closed)} mm, opening max ${mm(w.open)} mm, poses ${st.length === steps + 1 ? 'all' : st.join(',')}`);
}
const over = failMm === null ? [] : rows.filter(([, w]) => w.open * 1000 > failMm);
if (failMm !== null) console.log(over.length ? `FAILED: ${over.length} pair(s) deeper than ${failMm} mm while opening` : `OK: nothing deeper than ${failMm} mm while opening`);
process.exit(over.length ? 1 : 0);
