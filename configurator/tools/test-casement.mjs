#!/usr/bin/env node
// Headless checks of WindowModel against a casement cfg GLB (default public/Casement_V4_cfg.glb).
//   node tools/test-casement.mjs [path.glb]
// Checks resize (outer size, per-part split behaviour, hinge pivots follow pivotFactor), the hinge
// animation (90° preview angle, fixed shoe slide, outward swing, slider-crank linkage stays closed at
// every size), resizing while open, bit-exact reset, colours, explode and the hardware-fit report.
// Works for V1 (rotate only) and V2 (no hardware); hardware/linkage checks run only when present.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { loadGltf, WindowModel, ConfigError } from '../src/configurator/WindowModel.js';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || resolve(here, '../public/Casement_V4_cfg.glb');
const buf = readFileSync(file);
const gltf = await loadGltf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

let model;
try { model = new WindowModel(gltf); }
catch (e) { if (e instanceof ConfigError) { console.log(e.message); e.errors.forEach((x) => console.log('  ' + x)); process.exit(1); } throw e; }

const W0 = model.ref.width_m, H0 = model.ref.height_m;
const clip = model.clips.find((c) => c.direction === 'open');
const closeClip = model.clips.find((c) => c.direction === 'close') ?? null; // Casement_V4+
const hinge = model.hinges.find((h) => h.cfg.role === 'hingePivot');
const links = model.hinges.filter((h) => h.cfg.role === 'linkPivot');
const linkage = hinge.cfg.linkage;
const part = (re) => model.parts.find((p) => re.test(p.name));
const parts = (re) => model.parts.filter((p) => re.test(p.name));
const localBox = (p) => { const b = new THREE.Box3(); for (const { mesh } of p.meshes) { mesh.geometry.computeBoundingBox(); b.union(mesh.geometry.boundingBox); } return b; };
const refBoxes = new Map(model.parts.map((p) => [p, localBox(p)]));
const worldBox = (list) => { model.scene.updateMatrixWorld(true); const b = new THREE.Box3(); list.forEach((p) => b.expandByObject(p.object)); return b; };
const isIdentity = (m) => m.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-12);
const atTime = (t) => { model.stop(); model.play(clip.clip.name); model.update(t); model.scene.updateMatrixWorld(true); };
const dur = clip.clip.duration;

console.log(`file: ${file}`);
console.log(`parts: ${model.parts.length}, hinges: ${model.hinges.map((h) => h.name).join(', ')}, clip: ${clip.clip.name} (${clip.motion}, ${dur} s)`);
console.log(`limits: min W ${(model.limits.minWidth_m / 0.0254).toFixed(2)} in, min H ${(model.limits.minHeight_m / 0.0254).toFixed(2)} in, hardware fits from W ${model.limits.hardwareFitWidth_m == null ? '-' : (model.limits.hardwareFitWidth_m / 0.0254).toFixed(4) + ' in'}`);
check(model.clips.length === (closeClip ? 2 : 1) && model.clips.every((c) => c.motion !== 'translate'), 'rotate clips bound (open, plus close when present)');
if (closeClip) {
  console.log(`close clip: ${closeClip.clip.name}, exact reverse of ${clip.clip.name}: ${closeClip.mirrored}`);
  check(closeClip.counterpart === clip && clip.counterpart === closeClip, 'open/close clips paired');
  check(closeClip.mirrored === true, 'close clip verified as the exact time-reverse of the open clip');
}
check(clip.cfg.openAngle_deg === 90, 'root cfg openAngle_deg 90');

// Slider-crank joint B: on the sash arm and on the support arm (same point when closed, reference coords).
function linkageError(sideLink) {
  if (!linkage) return null;
  const side = sideLink.cfg.side;
  const sashArm = part(new RegExp(`^Hinge_${side === 'top' ? 'Top' : 'Bottom'}_SashArm`));
  const support = part(new RegExp(`^Hinge_${side === 'top' ? 'Top' : 'Bottom'}_SupportArm_[0-9]`));
  const dir = Math.sign(linkage.stud_m[0] - hinge.P.x);
  const B = (p) => new THREE.Vector3(hinge.P.x + dir * linkage.shoeToJoint_m + (model.width_m - W0) * p.cfg.x.below, 0, hinge.P.z);
  const bSash = sashArm.object.localToWorld(B(sashArm));
  const bSupport = support.object.localToWorld(B(support));
  const S = sideLink.pivot.getWorldPosition(new THREE.Vector3());
  const xz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  return { gap: xz(bSash, bSupport), arm: Math.abs(xz(bSash, S) - linkage.supportArm_m) };
}

const cases = [
  { W: W0, H: H0, label: 'reference 24 x 36 in' },
  { W: W0 + 0.3, H: H0 + 0.2, label: 'grow (+300 mm W, +200 mm H)' },
  { W: W0 - 0.2, H: H0 - 0.3, label: 'shrink (-200 mm W, -300 mm H)' },
  { W: 48 * 0.0254, H: 72 * 0.0254, label: '48 x 72 in' },
  { W: model.limits.minWidth_m + 0.01, H: model.limits.minHeight_m + 0.01, label: 'near geometric minimum' },
];

for (const c of cases) {
  console.log(`case: ${c.label}`);
  model.stop();
  model.setSize(c.W, c.H);
  const dW = c.W - W0, dH = c.H - H0;

  // Rest pose: outer size, per-part split behaviour, hinge pairs cancel, every part sits at identity.
  const fb = worldBox(parts(/^Frame_/));
  check(near(fb.min.x, 0) && near(fb.max.x, c.W) && near(fb.min.y, 0) && near(fb.max.y, c.H), `frame outside ${fb.max.x} x ${fb.max.y}`);
  for (const p of model.parts) {
    const r = refBoxes.get(p), b = localBox(p), { x, y } = p.cfg;
    const ex = (v, a, d) => v + d * (v < a.split_m ? a.below : a.above);
    check(near(b.min.x, ex(r.min.x, x, dW)) && near(b.max.x, ex(r.max.x, x, dW)), `${p.name} x-range`);
    check(near(b.min.y, ex(r.min.y, y, dH)) && near(b.max.y, ex(r.max.y, y, dH)), `${p.name} y-range`);
    check(b.min.z === r.min.z && b.max.z === r.max.z, `${p.name} depth changed`);
    check(isIdentity(p.object.matrixWorld), `${p.name} not at identity world transform at rest`);
  }
  for (const h of model.hinges) {
    const f = h.cfg.pivotFactor;
    check(h.pivot.position.equals(new THREE.Vector3(h.P.x + dW * f.x, h.P.y + dH * f.y, h.P.z)), `${h.name} rest pivot`);
    check(h.pivot.position.clone().add(h.offset.position).lengthSq() === 0, `${h.name} pivot + offset != 0`);
  }
  // Sash stays inside the frame's depth/extent and joints stay closed (sash grows by exactly dW / dH).
  const sb = worldBox(parts(/^Sash_(Left|Right|Top|Bottom)_[^_]+$/));
  const sr = new THREE.Box3(); parts(/^Sash_(Left|Right|Top|Bottom)_[^_]+$/).forEach((p) => sr.union(refBoxes.get(p)));
  check(near(sb.max.x - sb.min.x, sr.max.x - sr.min.x + dW) && near(sb.max.y - sb.min.y, sr.max.y - sr.min.y + dH), 'sash outline grows by dW x dH');

  // Animation: free edge swings outward, angle and shoe slide are size-independent, linkage stays closed.
  const right = part(new RegExp(`^Sash_${hinge.cfg.hingeSide === 'left' ? 'Right' : 'Left'}_[^_]+$`));
  const rb = localBox(right);
  const edge = new THREE.Vector3(hinge.cfg.hingeSide === 'left' ? rb.max.x : rb.min.x, (rb.min.y + rb.max.y) / 2, (rb.min.z + rb.max.z) / 2);
  const zRest = edge.z;
  atTime(dur);
  const zOpen = right.object.localToWorld(edge.clone()).z;
  const swing = 0.5 * (sb.max.x - sb.min.x); // at 90° the free edge moves out by about the sash width
  check(hinge.cfg.opens === 'outward' ? zOpen > zRest + swing : zOpen < zRest - swing, `free edge z ${zRest.toFixed(4)} -> ${zOpen.toFixed(4)} (${hinge.cfg.opens})`);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(hinge.pivot.quaternion.w))) * 180 / Math.PI;
  check(near(angle, clip.cfg.openAngle_deg, 1e-3), `open angle ${angle.toFixed(4)}°`);
  if (clip.cfg.slideTravel_m !== undefined) {
    const slide = hinge.pivot.position.x - (hinge.P.x + dW * hinge.cfg.pivotFactor.x);
    check(near(Math.abs(slide), clip.cfg.slideTravel_m, 1e-6), `shoe slide ${slide.toFixed(6)} m, expected ${clip.cfg.slideTravel_m}`);
  }
  let worst = { gap: 0, arm: 0 };
  for (let t = 0; t <= dur + 1e-9; t += dur / 24) {
    atTime(t);
    for (const l of links) { const e = linkageError(l); if (e) worst = { gap: Math.max(worst.gap, e.gap), arm: Math.max(worst.arm, e.arm) }; }
  }
  if (links.length && linkage) {
    console.log(`  linkage: worst joint gap ${(worst.gap * 1000).toFixed(4)} mm, support-arm length error ${(worst.arm * 1000).toFixed(4)} mm`);
    check(worst.gap < 2e-4 && worst.arm < 2e-4, 'slider-crank joint stays closed (< 0.2 mm) through the swing');
  }
  model.stop();
  model.scene.updateMatrixWorld(true);
  check(model.parts.every((p) => isIdentity(p.object.matrixWorld)), 'Close returns every part to identity');
}

// Resize while the sash is held open, then close: the new rest pose must be used, not the old one.
console.log('case: resize while open');
model.setSize(W0, H0);
atTime(dur);
model.setSize(W0 + 0.1, H0 + 0.2);
model.scene.updateMatrixWorld(true);
const angleAfter = 2 * Math.acos(Math.min(1, Math.abs(hinge.pivot.quaternion.w))) * 180 / Math.PI;
check(near(angleAfter, clip.cfg.openAngle_deg, 1e-3), `still open after resize (${angleAfter.toFixed(3)}°)`);
for (const l of links) { const e = linkageError(l); if (e) check(e.gap < 2e-4 && e.arm < 2e-4, `${l.name} linkage closed after resize while open`); }
model.stop();
model.scene.updateMatrixWorld(true);
const rdW = (W0 + 0.1) - W0, rdH = (H0 + 0.2) - H0; // the deltas setSize actually computed
for (const h of model.hinges) {
  const f = h.cfg.pivotFactor;
  check(h.pivot.position.equals(new THREE.Vector3(h.P.x + rdW * f.x, h.P.y + rdH * f.y, h.P.z)) && h.pivot.quaternion.w === 1, `${h.name} closes to the new rest pivot`);
}
check(model.parts.every((p) => isIdentity(p.object.matrixWorld)), 'after resize-while-open + Close, every part is at identity');

// Close clip (Casement_V4+): closes from open, reverses mid-swing without a jump, is a no-op when closed,
// keeps the linkage closed, and ends exactly at rest at any size.
if (closeClip) {
  const pose = () => { model.scene.updateMatrixWorld(true); return { p: hinge.pivot.position.clone(), q: hinge.pivot.quaternion.clone(), s: links.map((l) => l.pivot.quaternion.clone()) }; };
  // Compare quaternion components: angleTo (2·acos(dot)) is ~5e-4 even for identical float32 keys that are
  // not exactly unit length.
  const qd = (a, b) => Math.max(...a.toArray().map((v, i) => Math.abs(Math.abs(v) - Math.abs(b.toArray()[i]))));
  const samePose = (a, b, tol) => a.p.distanceTo(b.p) < tol && qd(a.q, b.q) < tol && a.s.every((q, i) => qd(q, b.s[i]) < tol);
  const cdur = closeClip.clip.duration;
  for (const [W, H, label] of [[W0, H0, 'reference'], [W0 + 0.3, H0 + 0.2, 'grow'], [W0 - 0.2, H0 - 0.3, 'shrink']]) {
    console.log(`case: close clip at ${label}`);
    model.stop();
    model.setSize(W, H);
    const rest = pose();
    // Fully open, then close: starts at the open pose, ends at rest.
    model.play(clip.clip.name); model.update(dur);
    const open = pose();
    model.play(closeClip.clip.name); model.update(0);
    check(samePose(pose(), open, 1e-9), 'close starts from the open pose (no jump)');
    check(!clip.action.isScheduled(), 'open action stopped when close starts');
    let worst = { gap: 0, arm: 0 };
    for (let i = 0; i < 24; i++) { model.update(cdur / 24); model.scene.updateMatrixWorld(true); for (const l of links) { const e = linkageError(l); if (e) worst = { gap: Math.max(worst.gap, e.gap), arm: Math.max(worst.arm, e.arm) }; } }
    if (links.length && linkage) check(worst.gap < 2e-4 && worst.arm < 2e-4, `linkage closed while closing (gap ${(worst.gap * 1000).toFixed(4)} mm)`);
    model.update(0.5); // past the end: clamped
    check(samePose(pose(), rest, 1e-6), 'close clip ends at the rest pose');
    model.scene.updateMatrixWorld(true);
    check(model.parts.every((p) => p.object.matrixWorld.elements.every((v, k) => Math.abs(v - (k % 5 === 0 ? 1 : 0)) < 1e-6)), 'after closing, every part is back at identity (within float32 keys)');
    // Reverse mid-swing: open to 1.2 s, then close continues from the mirrored time, and back again.
    model.stop(); model.play(clip.clip.name); model.update(1.2);
    const mid = pose();
    model.play(closeClip.clip.name); model.update(0);
    check(samePose(pose(), mid, 1e-6), 'switching to close mid-swing keeps the pose');
    check(near(closeClip.action.time, cdur - 1.2, 1e-9), `close resumes at mirrored time ${closeClip.action.time}`);
    model.update(0.7);
    const mid2 = pose();
    model.play(clip.clip.name); model.update(0);
    check(samePose(pose(), mid2, 1e-6), 'switching back to open mid-swing keeps the pose');
    // Close when already closed: stays closed.
    model.stop(); model.play(closeClip.clip.name); model.update(0); model.update(0.1);
    check(samePose(pose(), rest, 1e-6), 'close while closed is a no-op');
    // Resize half-way through closing, then let it finish: ends at the new rest pose.
    model.stop(); model.play(clip.clip.name); model.update(dur); model.play(closeClip.clip.name); model.update(cdur / 2);
    model.setSize(W + 0.05, H + 0.05);
    const dW2 = (W + 0.05) - W0, dH2 = (H + 0.05) - H0;
    model.update(cdur);
    model.scene.updateMatrixWorld(true);
    for (const l of links) { const e = linkageError(l); if (e) check(e.gap < 2e-4 && e.arm < 2e-4, `${l.name} linkage closed after resize mid-close`); }
    check(hinge.pivot.position.distanceTo(new THREE.Vector3(hinge.P.x + dW2 * hinge.cfg.pivotFactor.x, hinge.P.y + dH2 * hinge.cfg.pivotFactor.y, hinge.P.z)) < 1e-7 && qd(hinge.pivot.quaternion, new THREE.Quaternion()) < 1e-6,
      'resize mid-close: finishes at the new rest pivot');
  }
  model.stop();
  model.play(null);
  check(clip.action.isScheduled() && !closeClip.action.isScheduled(), 'play(all) opens only (close clips play by name)');
  model.stop();
}

// Synthetic right-hinge behaviour (pivotFactor.x = 1, set in memory only; the GLB is left-hinged).
// The pivot's translation is animated, so the mixer's saved rest pose must follow the resize.
{
  console.log('case: synthetic pivotFactor.x = 1, resize while open');
  const g2 = await loadGltf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  g2.scene.getObjectByName(hinge.name).userData.cfg.pivotFactor.x = 1;
  const m2 = new WindowModel(g2);
  const h2 = m2.hinges.find((h) => h.name === hinge.name);
  m2.play(); m2.update(dur);
  m2.setSize(W0 + 0.1, H0);
  const d = (W0 + 0.1) - W0;
  const pt = m2.clips[0].posTracks.find((t) => t.hinge === h2);
  if (pt) {
    // Keyframes are Float32Array, so shifted keys are float32-rounded (~1e-8 m).
    check(near(h2.pivot.position.x, pt.refValues[pt.refValues.length - 3] + d, 1e-7), 'open pivot follows dW while held open');
    check(pt.track.values.every((v, i) => v === Math.fround(pt.refValues[i] + (i % 3 === 0 ? d : 0))), 'clip position keys shifted by dW');
  }
  m2.stop();
  check(h2.pivot.position.equals(new THREE.Vector3(h2.P.x + d, h2.P.y, h2.P.z)), `Close returns to the new rest pivot (x ${h2.pivot.position.x} vs ${h2.P.x + d})`);
  check(h2.offset.position.equals(h2.pivot.position.clone().negate()), 'offset cancels the new pivot');
  m2.dispose();
}

// Reset must be bit-exact after many edits (geometry, clip keys, hinge nodes).
for (let i = 0; i < 50; i++) model.setSize(W0 + Math.sin(i) * 0.3, H0 + Math.cos(i) * 0.3);
model.setSize(W0, H0);
let exact = true;
for (const p of model.parts) for (const { mesh, ref } of p.meshes) {
  const a = mesh.geometry.getAttribute('position').array;
  for (let i = 0; i < a.length; i++) if (a[i] !== ref[i]) { exact = false; break; }
}
check(exact, 'geometry bit-exact after 50 edits + reset');
check(clip.posTracks.every((t) => t.track.values.every((v, i) => v === t.refValues[i])), 'clip position keys restored exactly');
check(model.hinges.every((h) => h.pivot.position.equals(h.P) && h.offset.position.equals(h.P.clone().negate())), 'hinge nodes restored exactly');

let threw = false;
try { model.setSize(model.limits.minWidth_m - 0.01, H0); } catch { threw = true; }
check(threw, 'setSize below geometric limit throws');

// Colours: PVC zones change, glass / gasket / hardware keep their GLB materials.
const before = new Map(model.materials().map((m) => [m, m.color.getHexString()]));
model.setZoneColor('exterior', '#ff0000');
model.setZoneColor('interior', '#0000ff');
const used = new Set(model.parts.flatMap((p) => p.meshes.map((m) => m.mesh.material.color.getHexString())));
check(used.has('ff0000') && used.has('0000ff'), 'both colour zones in use');
for (const p of model.parts.filter((q) => q.cfg.role !== 'profile')) {
  for (const { mesh } of p.meshes) check(mesh.material.color.getHexString() === before.get(mesh.material), `${p.name} (${p.cfg.role}) not recoloured`);
}

// Explode moves casement assemblies and 0 restores identity exactly.
model.setExplode(1);
check(['Sash', 'Bead'].every((a) => model.parts.some((p) => p.cfg.assembly === a && p.object.position.lengthSq() > 0)), 'explode moves Sash and Bead');
if (model.parts.some((p) => p.cfg.role === 'hardware')) check(model.parts.filter((p) => p.cfg.role === 'hardware').every((p) => p.object.position.lengthSq() > 0), 'explode moves hinge hardware');
model.setExplode(0);
model.scene.updateMatrixWorld(true);
check(model.parts.every((p) => isIdentity(p.object.matrixWorld)), 'explode 0 restores identity');

// Hardware-fit report = furthest fixed hardware edge from the hinge side.
const hw = model.parts.filter((p) => p.cfg.role === 'hardware');
if (hw.length) {
  const maxX = Math.max(...hw.map((p) => refBoxes.get(p).max.x));
  check(hinge.cfg.pivotFactor.x !== 0 || model.limits.hardwareFitWidth_m === maxX, `hardware fit width ${model.limits.hardwareFitWidth_m} = max hardware x ${maxX}`);
} else check(model.limits.hardwareFitWidth_m === null, 'no hardware -> no fit width');

console.log(failures ? `FAILED: ${failures} failed, ${passes} passed` : `OK: ${passes} checks passed`);
process.exit(failures ? 1 : 0);
