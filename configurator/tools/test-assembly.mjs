#!/usr/bin/env node
// Headless checks for the multi-window layout (assembly.js) and WindowAssembly with real GLBs.
//   node tools/test-assembly.mjs
// Layout: placement on each side, derived positions follow resizes, overlaps are blocked (never clamped), removal
// rules. Assembly: every window's geometry lands exactly in its layout rectangle, windows of different types sit side
// by side, and size / colour / animation of one window never touch another.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { loadGltf, WindowModel } from '../src/configurator/WindowModel.js';
import { WindowAssembly, frameBack_m, FRAME_ASSEMBLY } from '../src/configurator/WindowAssembly.js';
import { placeAll, placeOn, overlaps, checkAdd, checkResize, checkRemove, removeFrom, extents } from '../src/configurator/assembly.js';
import { inToM } from '../src/configurator/deform.js';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const rectIs = (r, x, y, w, h) => r && r.x === x && r.y === y && r.w === w && r.h === h;

// ---------------- pure layout ----------------
console.log('layout');
{
  const P = { x: 10, y: 20, w: 24, h: 36 };
  check(rectIs(placeOn(P, 'right', 30, 40), 34, 20, 30, 40), 'right: x = P.x + P.w, bottoms aligned');
  check(rectIs(placeOn(P, 'left', 30, 40), -20, 20, 30, 40), 'left: x = P.x - w, bottoms aligned');
  check(rectIs(placeOn(P, 'top', 30, 40), 10, 56, 30, 40), 'top: y = P.y + P.h, left edges aligned');
  check(rectIs(placeOn(P, 'bottom', 30, 40), 10, -20, 30, 40), 'bottom: y = P.y - h, left edges aligned');
  check(throws(() => placeOn(P, 'diagonal', 1, 1)), 'unknown side throws');

  check(!overlaps({ x: 0, y: 0, w: 24, h: 36 }, { x: 24, y: 0, w: 24, h: 36 }), 'touching edges do not overlap');
  check(overlaps({ x: 0, y: 0, w: 24, h: 36 }, { x: 23.875, y: 0, w: 24, h: 36 }), '1/8 in overlap is detected');
  check(!overlaps({ x: 0, y: 0, w: 24.3, h: 36 }, { x: 24.3 + 1e-9, y: 0, w: 1, h: 1 }), 'float noise is not an overlap');

  // W1 root 24x36, W2 right 30x36, W3 above W1 24x20, W4 left of W1 18x36, W5 below W2 30x12
  let L = [
    { id: 1, parent: null, side: null, w: 24, h: 36 },
    { id: 2, parent: 1, side: 'right', w: 30, h: 36 },
    { id: 3, parent: 1, side: 'top', w: 24, h: 20 },
    { id: 4, parent: 1, side: 'left', w: 18, h: 36 },
    { id: 5, parent: 2, side: 'bottom', w: 30, h: 12 },
  ];
  let R = placeAll(L);
  check(rectIs(R.get(1), 0, 0, 24, 36), 'root at origin');
  check(rectIs(R.get(2), 24, 0, 30, 36), 'W2 right of W1');
  check(rectIs(R.get(3), 0, 36, 24, 20), 'W3 above W1');
  check(rectIs(R.get(4), -18, 0, 18, 36), 'W4 left of W1');
  check(rectIs(R.get(5), 24, -12, 30, 12), 'W5 below W2');
  const e = extents(R);
  check(e.minX === -18 && e.maxX === 54 && e.minY === -12 && e.maxY === 56 && e.w === 72 && e.h === 68, 'extents');

  // Order independence: children listed before parents still place the same.
  const R2 = placeAll([...L].reverse());
  check([...R].every(([id, r]) => rectIs(R2.get(id), r.x, r.y, r.w, r.h)), 'placement does not depend on list order');
  check(throws(() => placeAll([...L, { id: 9, parent: 99, side: 'right', w: 1, h: 1 }])), 'missing parent throws');
  check(throws(() => placeAll([{ id: 1, parent: 2, side: 'left', w: 1, h: 1 }, { id: 2, parent: 1, side: 'left', w: 1, h: 1 }])), 'no root / cycle throws');
  check(throws(() => placeAll([...L, { id: 1, parent: null, side: null, w: 1, h: 1 }])), 'duplicate id throws');

  // Adds
  check(checkAdd(L, 2, 'right', 24, 36).ok, 'free side can be added');
  check(!checkAdd(L, 1, 'right', 24, 36).ok, 'occupied side is blocked');
  check(checkAdd(L, 1, 'right', 24, 36).overlapId === 2, 'checkAdd reports what it overlaps');
  check(checkAdd(L, 2, 'top', 30, 36).ok, 'above W2 is free (W3 sits above W1 only)');
  // Right of W3 (x 24..54, y 36..56) only touches W2's top edge (y 36): allowed.
  check(checkAdd(L, 3, 'right', 30, 20).ok, 'right of W3 is free');
  check(checkAdd(L, 4, 'bottom', 18, 36).ok, 'below W4 is free');
  check(!checkAdd(L, 1, 'bottom', 30, 12).ok, 'below W1, 30 wide, would overlap W5');
  check(checkAdd(L, 1, 'bottom', 24, 12).ok, 'below W1, 24 wide, touches W5 only');
  check(!checkAdd(L, 1, 'nowhere', 1, 1).ok && !checkAdd(L, 42, 'right', 1, 1).ok, 'bad side / bad parent rejected');

  // Resize: attached windows follow; overlaps are blocked.
  check(checkResize(L, 1, 30, 36).ok, 'W1 wider: W2 and W5 move right, nothing overlaps');
  const L2 = L.map((u) => (u.id === 1 ? { ...u, w: 30 } : u));
  const R3 = placeAll(L2);
  check(rectIs(R3.get(2), 30, 0, 30, 36) && rectIs(R3.get(5), 30, -12, 30, 12), 'right / below-right windows moved by ΔW');
  check(rectIs(R3.get(4), -18, 0, 18, 36), 'left window does not move when W1 grows');
  check(rectIs(R3.get(3), 0, 36, 24, 20), 'top window keeps its own width');
  check(checkResize(L, 3, 30, 20).ok, 'W3 wider (nothing above W2) is allowed');
  const L3 = [...L, { id: 6, parent: 2, side: 'top', w: 30, h: 20 }];
  check(!checkResize(L3, 3, 30, 20).ok, 'W3 wider into W6 is blocked');
  check(checkResize(L3, 3, 30, 20).overlapIds?.includes(6), 'resize reports the overlapping windows');
  check(!checkResize(L, 99, 1, 1).ok, 'unknown window cannot be resized');

  // Remove
  check(checkRemove(L, 5).ok && checkRemove(L, 3).ok && checkRemove(L, 4).ok, 'leaf windows can be removed');
  check(!checkRemove(L, 2).ok && checkRemove(L, 2).blockers?.[0] === 5, 'window with an attached window is blocked');
  check(!checkRemove(L, 1).ok, 'root with several attached windows is blocked');
  check(!checkRemove([L[0]], 1).ok, 'last window cannot be removed');
  const two = [L[0], L[1]];
  check(checkRemove(two, 1).ok && checkRemove(two, 1).newRoot === 2, 'root with one attached window: it becomes the root');
  const afterRoot = removeFrom([L[0], L[1], L[4]], 1);
  const R4 = placeAll(afterRoot);
  check(rectIs(R4.get(2), 0, 0, 30, 36) && rectIs(R4.get(5), 0, -12, 30, 12), 'after root removal the rest keeps its relative layout');
  check(throws(() => removeFrom(L, 2)), 'removeFrom throws when not allowed');
  check(removeFrom(L, 5).length === 4 && !removeFrom(L, 5).some((u) => u.id === 5), 'removeFrom returns the layout without it');
  check(L.length === 5, 'inputs are not mutated');
}

// ---------------- WindowAssembly with real GLBs ----------------
console.log('assembly (Window_V3 + Casement_V4)');
const bufOf = (f) => { const b = readFileSync(resolve(here, '../public', f)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const V3 = bufOf('Window_V3_cfg.glb'), CS = bufOf('Casement_V4_cfg.glb');
const make = async (buf) => new WindowModel(await loadGltf(buf.slice(0)));
const T3 = { key: 'Window_V3_cfg.glb', label: 'V3' }, TC = { key: 'Casement_V4_cfg.glb', label: 'Casement' };

const a = new WindowAssembly();
const m1 = await make(V3);
const id1 = a.add(m1, { w: 24, h: 36, type: T3, colors: { ...m1.initialColors } });
const m2 = await make(CS);
const id2 = a.add(m2, { parent: id1, side: 'right', w: 24, h: 36, type: TC, colors: { ...m2.initialColors } });
const m3 = await make(V3);
const id3 = a.add(m3, { parent: id1, side: 'top', w: 24, h: 18, type: T3, colors: { ...m1.initialColors } });
const m4 = await make(CS);
const id4 = a.add(m4, { parent: id2, side: 'bottom', w: 30, h: 24, type: TC, colors: { ...m2.initialColors } });

/** Each window's world-space bounds equal its layout rectangle (frame outside), in metres. */
function boundsMatchLayout(label) {
  a.scene.updateMatrixWorld(true);
  const R = a.rects();
  for (const u of a.units) {
    const r = R.get(u.id);
    const b = new THREE.Box3().setFromObject(u.model.root);
    const ok = near(b.min.x, inToM(r.x)) && near(b.max.x, inToM(r.x + r.w)) && near(b.min.y, inToM(r.y)) && near(b.max.y, inToM(r.y + r.h));
    check(ok, `${label}: W${u.id} bounds [${b.min.x.toFixed(5)},${b.max.x.toFixed(5)}]x[${b.min.y.toFixed(5)},${b.max.y.toFixed(5)}] vs layout ${JSON.stringify(r)}`);
  }
}
boundsMatchLayout('initial');
check(a.units.length === 4 && new Set(a.models).size === 4, 'four independent models');

// Jamb extensions are never rendered (user 2026-11-24). They stay loaded but set no position and no wall depth.
const extParts = (m) => m.parts.filter((p) => p.cfg.assembly === 'Extension');
check(a.models.every((m) => extParts(m).length === 4 && extParts(m).every((p) => p.object.visible === false && p.hidden)), 'every jamb extension part is loaded but not visible');
check(a.models.every((m) => m.parts.filter((p) => !p.hidden).every((p) => p.object.visible === true)), 'every other part stays visible');
{
  const capMeshes = new Set(Object.values(a.capGroups()).flat());
  check(a.models.every((m) => extParts(m).every((p) => p.meshes.every(({ mesh }) => !capMeshes.has(mesh)))), 'hidden extensions get no section caps');
}

// Depth alignment (user 2026-11-24, "the bottoms of the frames need to meet"): every window's frame interior (back)
// face lies on one plane, the deepest frame's. Window_V3 frame 3.979 in, Casement_V4 3.250 in, so the double-hungs stay
// at z = 0 and the casements move 0.729 in to the interior: backs flush, fronts step.
const frameBox = (u) => {
  u.holder.updateMatrixWorld(true);
  const b = new THREE.Box3();
  for (const p of u.model.parts) if (p.cfg.assembly === FRAME_ASSEMBLY) b.expandByObject(p.object);
  return b;
};
const visibleZ = (pick) => pick(...a.units.flatMap((u) => u.model.parts.filter((p) => !p.hidden).map((p) => { u.holder.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(p.object); return pick === Math.min ? b.min.z : b.max.z; })));
function framesAligned(label) {
  const backs = a.units.map((u) => frameBox(u).min.z);
  check(backs.every((z) => near(z, backs[0], 1e-9)), `${label}: frame backs flush (${backs.map((z) => (z / 0.0254).toFixed(4)).join(', ')} in)`);
  check(near(backs[0], Math.min(...a.units.map((u) => frameBack_m(u.model))), 1e-12), `${label}: shared plane is the deepest frame back`);
  check(a.units.every((u) => a.depthOffset_m(u.id) <= 0), `${label}: windows only move toward the interior`);
  const d = a.restDepth_m();
  check(near(d.max, visibleZ(Math.max), 1e-9) && near(d.min, visibleZ(Math.min), 1e-9), `${label}: wall spans the visible parts (${(d.min / 0.0254).toFixed(3)} .. ${(d.max / 0.0254).toFixed(3)} in)`);
}
framesAligned('initial');
check(near(frameBack_m(m1) / 0.0254, -3.979, 1e-3) && near(frameBack_m(m2) / 0.0254, -3.250, 1e-3), 'frame backs read from GLB data (Window_V3 -3.979 in, Casement_V4 -3.250 in)');
check(a.depthOffset_m(id1) === 0 && a.depthOffset_m(id3) === 0, 'double-hungs (deepest frame) stay at z = 0');
check(near(a.depthOffset_m(id2) / 0.0254, -0.729, 1e-3) && a.depthOffset_m(id2) === a.depthOffset_m(id4), 'casements move 0.729 in to the interior');
{
  const dh = frameBox(a.get(id1)), cs = frameBox(a.get(id2));
  check(near((cs.max.z - dh.max.z) / 0.0254, -0.729, 1e-3), `frame fronts step ${((cs.max.z - dh.max.z) / 0.0254).toFixed(3)} in on the exterior side only`);
  check(near(a.restDepth_m().max, 0, 1e-6), 'wall exterior face at the deepest frame front (z = 0)');
  check(near(a.restDepth_m().min / 0.0254, -4.194, 1e-3), `wall interior face at the deepest visible part (Window_V3 sash back), not the hidden extension (-8.229 in)`);
  const d0 = a.restDepth_m().min;
  m1.setExplode(1);
  check(near(a.restDepth_m().min, d0, 0), 'rest depth ignores explode');
  m1.setExplode(0);
  a.setExplode(1); a.setExplode(0);
  check(a.models.every((m) => extParts(m).every((p) => p.object.visible === false)), 'explode round trip keeps extensions hidden');
}
{
  // The extension no longer matters for placement: types with and without one can be combined, all flush at z = 0.
  const makeNoExt = async () => {
    const m = await make(CS);
    for (const p of m.parts) if (p.cfg.assembly === 'Extension') p.cfg = { ...p.cfg, assembly: 'NotExtension' };
    return m;
  };
  const TN = { key: 'noext', label: 'Casement without extension' };
  const mix = new WindowAssembly();
  const xid1 = mix.add(await make(V3), { w: 24, h: 36, type: T3, colors: {} });
  const xid2 = mix.add(await makeNoExt(), { parent: xid1, side: 'right', w: 24, h: 36, type: TN, colors: {} });
  check(mix.units.length === 2 && near(frameBox(mix.get(xid2)).min.z, frameBox(mix.get(xid1)).min.z, 1e-9), 'a type without an extension can sit next to one with an extension, frame backs flush');
  const swapped = await makeNoExt();
  mix.replaceModel(xid1, swapped, TN);
  check(mix.get(xid1).model === swapped && near(frameBox(mix.get(xid1)).min.z, frameBox(mix.get(xid2)).min.z, 1e-9), 'a type change between with and without extension is allowed, backs still flush');
  mix.dispose();
  // A type without frame parts cannot be aligned: refused, nothing added.
  const nf = await make(CS);
  for (const p of nf.parts) if (p.cfg.assembly === FRAME_ASSEMBLY) p.cfg = { ...p.cfg, assembly: 'NotFrame' };
  const lone = new WindowAssembly();
  check(throws(() => lone.add(nf, { w: 24, h: 36, type: TC, colors: {} })) && lone.units.length === 0, 'type without frame parts is refused, not placed at a guessed depth');
  nf.dispose();
}

// Nothing shared between windows of the same type.
const geoms = (m) => new Set(m.parts.flatMap((p) => p.meshes.map((x) => x.mesh.geometry)));
const g1 = geoms(m1), g3 = geoms(m3);
check(![...g1].some((g) => g3.has(g)), 'same-type windows share no geometry');
check(!m1.materials().some((x) => m3.materials().includes(x)), 'same-type windows share no materials');
check(!m2.clips.some((c) => m4.clips.some((d) => d.clip === c.clip || d.clip.tracks.some((t) => c.clip.tracks.includes(t)))), 'same-type windows share no clips or tracks');

// Size of one window does not touch another window's geometry.
const snap = (m) => m.parts.flatMap((p) => p.meshes.map((x) => x.mesh.geometry.getAttribute('position').array.slice()));
const before3 = snap(m3), before4 = snap(m4);
a.setSize(id1, 30, 36);
boundsMatchLayout('after W1 wider');
check(near(a.worldRect(id2).x, inToM(30)), 'W2 moved right with W1');
const same = (x, y) => x.length === y.length && x.every((arr, i) => arr.every((v, j) => v === y[i][j]));
check(same(before3, snap(m3)) && same(before4, snap(m4)), 'resizing W1 leaves the other windows\' geometry bit-identical');
check(!throws(() => a.setSize(id3, 60, 18)), 'W3 can grow over the free area above W2');
boundsMatchLayout('after W3 wider');
const m5 = await make(V3);
check(throws(() => a.add(m5, { parent: id1, side: 'right', w: 24, h: 36, type: T3, colors: {} })), 'add into an occupied slot throws');
check(a.units.length === 4, 'blocked add leaves the layout unchanged');
check(throws(() => a.setSize(id1, m1.limits.minWidth_m / 0.0254 - 1, 36)), 'below the geometric limit throws');
check(a.get(id1).w === 30, 'blocked resize keeps the stored size');
m5.dispose();

// Colours are per window.
a.setColor(id1, 'exterior', '#ff0000');
const ext = (m) => m.zoneMaterials.exterior?.color.getHexString();
check(ext(m1) === 'ff0000' && ext(m3) !== 'ff0000', 'colour on W1 does not reach W3 (same type)');
check(a.get(id1).colors.exterior === '#ff0000' && a.get(id3).colors.exterior !== '#ff0000', 'stored colours are per window');

// Animation is per window.
m2.play(null);
m2.update(1.0);
check(m2.isAnimating() && !m4.isAnimating() && !m1.isAnimating(), 'playing W2 does not start W4 or W1');
const hingeQ = (m) => m.hinges.find((h) => h.cfg.role === 'hingePivot')?.pivot.quaternion.w ?? 1;
check(hingeQ(m2) < 1 - 1e-6 && near(hingeQ(m4), 1, 1e-12), 'W2 sash swings, W4 sash stays shut');
a.update(10);
a.stop();
check(!a.isAnimating(), 'stop() halts every window');

// Type change keeps place, size and colours.
const before = { ...a.rects().get(id3) };
const mC = await make(CS);
a.replaceModel(id3, mC, TC);
check(a.get(id3).type.key === TC.key && a.get(id3).model === mC, 'W3 is now a casement');
check(rectIs(a.rects().get(id3), before.x, before.y, before.w, before.h), 'type change keeps the rectangle');
boundsMatchLayout('after W3 type change');
framesAligned('after W3 type change');

// Explode spreads windows; 0 restores the exact layout positions.
a.setExplode(1);
check(a.worldRect(id4).y < inToM(a.rects().get(id4).y), 'exploded: lower window moves down');
a.setExplode(0);
check(a.units.every((u) => { const r = a.rects().get(u.id); const p = u.holder.position; return p.x === inToM(r.x) && p.y === inToM(r.y) && p.z === a.depthOffset_m(u.id); }), 'explode 0 restores exact positions');
framesAligned('after explode round trip');
boundsMatchLayout('after explode round trip');

// Remove
check(throws(() => a.remove(id2)), 'W2 (W4 attached) cannot be removed');
a.remove(id4);
check(!a.get(id4) && a.units.length === 3 && !a.scene.children.some((h) => h.userData.windowId === id4), 'W4 removed from layout and scene');
a.remove(id3);
a.remove(id1); // root with one attached window (W2) → W2 becomes root
check(a.units.length === 1 && a.units[0].id === id2 && a.units[0].parent === null, 'W2 is the new root');
check(rectIs(a.rects().get(id2), 0, 0, 24, 36), 'new root at the origin');
check(a.depthOffset_m(id2) === 0 && a.units[0].holder.position.z === 0, 'only casement left: back at z = 0');
boundsMatchLayout('after removals');
check(throws(() => a.remove(id2)), 'last window cannot be removed');

console.log(failures ? `FAILED: ${failures} failed, ${passes} passed` : `OK: ${passes} checks passed`);
process.exit(failures ? 1 : 0);
