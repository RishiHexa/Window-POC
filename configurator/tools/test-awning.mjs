#!/usr/bin/env node
// Headless checks for horizontal hinge axes (awning / hopper, davinci.window.hinge/1 with axis "x").
//   node tools/test-awning.mjs
// No awning GLB exists yet, so this builds a small synthetic awning in code: a 4-member frame and a sash hinged at
// the head about +X, opening outward by 30°. The sizes and the angle are TEST DATA ONLY, not product values.
// Checks: it loads; the sash swings outward about the head; the pivot follows the head on resize (pivotFactor.y = 1);
// resize while open resumes; stop restores the exact rest pose; and every axis mismatch is refused.

import * as THREE from 'three';
import { WindowModel, ConfigError } from '../src/configurator/WindowModel.js';
import { WindowAssembly } from '../src/configurator/WindowAssembly.js';
import { ROOT_SCHEMA, PART_SCHEMA, HINGE_SCHEMA, quaternionAxisError } from '../src/configurator/schema.js';

let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log(`  FAIL ${msg}`); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const W = 0.6, H = 0.9, T = 0.05;            // test frame: outside size and member width (m)
const P = [0, H - T, -0.02];                  // hinge axis point: head of the sash, exterior face of the sash
const ANGLE = -Math.PI / 6;                   // -30° about +X: the bottom rail moves to +Z (outward)
const SASH_BOTTOM = [W / 2, T, -0.02];        // a point on the sash's bottom rail, exterior face (reference coords)

const axisSplit = (split, below, above) => ({ split_m: split, below, above });
function part(role, assembly, side, x, y, colorZone) {
  return { schema: PART_SCHEMA, role, assembly, side, canScaleX: x.below !== x.above, canScaleY: y.below !== y.above, x, y, colorZone };
}
function box(name, [x0, x1], [y0, y1], [z0, z1], cfg) {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xffffff }));
  m.name = name;
  m.userData.cfg = cfg;
  return m;
}

/** Synthetic awning. `hinge`, `anim` patch the hinge pivot cfg / root animation entry; `rotAxis` is the clip's axis. */
function build({ hinge = {}, anim = {}, rotAxis = new THREE.Vector3(1, 0, 0) } = {}) {
  const sx = W / 2, sy = H / 2;
  const root = new THREE.Group();
  root.name = 'Window_AwningTest';
  root.userData.cfg = {
    schema: ROOT_SCHEMA, units: 'm', windowType: 'awning',
    reference: { width_m: W, height_m: H },
    animations: [{ clip: 'Sash_Hinge', node: 'Sash_Hinge', motion: 'rotate', axis: 'x', openAngle_deg: 30, label: 'Sash', ...anim }],
  };
  const Z = [-0.08, 0];
  root.add(box('Frame_Left', [0, T], [0, H], Z, part('profile', 'Frame', 'left', axisSplit(sx, 0, 0), axisSplit(sy, 0, 1), 'exterior')));
  root.add(box('Frame_Right', [W - T, W], [0, H], Z, part('profile', 'Frame', 'right', axisSplit(sx, 1, 1), axisSplit(sy, 0, 1), 'exterior')));
  root.add(box('Frame_Top', [0, W], [H - T, H], Z, part('profile', 'Frame', 'top', axisSplit(sx, 0, 1), axisSplit(sy, 1, 1), 'exterior')));
  root.add(box('Frame_Bottom', [0, W], [0, T], Z, part('profile', 'Frame', 'bottom', axisSplit(sx, 0, 1), axisSplit(sy, 0, 0), 'exterior')));

  const pivot = new THREE.Group();
  pivot.name = 'Sash_Hinge';
  pivot.userData.cfg = {
    schema: HINGE_SCHEMA, role: 'hingePivot', assembly: 'Sash', clip: 'Sash_Hinge', offsetNode: 'Sash_HingeOffset',
    axis: 'x', pivot_m: [...P], pivotFactor: { x: 0, y: 1 }, hingeSide: 'top', opens: 'outward', motion: 'rotate', ...hinge,
  };
  pivot.position.fromArray(P);
  const offset = new THREE.Group();
  offset.name = 'Sash_HingeOffset';
  offset.userData.cfg = { schema: HINGE_SCHEMA, role: 'hingeOffset', assembly: 'Sash', pivotNode: 'Sash_Hinge' };
  offset.position.set(-P[0], -P[1], -P[2]);
  const sash = box('SashGlass', [T, W - T], [T, H - T], [-0.06, -0.02], part('glass', 'Sash', 'infill', axisSplit(sx, 0, 1), axisSplit(sy, 0, 1), 'glass'));
  offset.add(sash);
  pivot.add(offset);
  root.add(pivot);

  const n = 11, times = [], values = [];
  for (let i = 0; i < n; i++) {
    times.push((3 * i) / (n - 1));
    values.push(...new THREE.Quaternion().setFromAxisAngle(rotAxis, (ANGLE * i) / (n - 1)).toArray());
  }
  const clip = new THREE.AnimationClip('Sash_Hinge', 3, [new THREE.QuaternionKeyframeTrack('Sash_Hinge.quaternion', times, values)]);
  const scene = new THREE.Group();
  scene.add(root);
  return { scene, animations: [clip] };
}

const errorsOf = (opts) => { try { new WindowModel(build(opts)); return []; } catch (e) { return e instanceof ConfigError ? e.errors : [String(e)]; } };
const refused = (opts, pattern, msg) => {
  const errs = errorsOf(opts);
  check(errs.some((e) => pattern.test(e)), `${msg} (errors: ${errs.join(' | ') || 'none'})`);
};

// ---------- loads ----------
console.log('awning (synthetic, axis x)');
let model;
try { model = new WindowModel(build()); }
catch (e) { console.log(e.message); (e.errors || []).forEach((x) => console.log('  ' + x)); process.exit(1); }
check(model.hinges.length === 1 && model.hinges[0].cfg.axis === 'x' && model.hinges[0].cfg.hingeSide === 'top', 'horizontal hinge at the head is accepted');
check(model.clips.length === 1 && model.clips[0].motion === 'rotate', 'rotate clip bound');

const sash = model.scene.getObjectByName('SashGlass');
const pivot = model.hinges[0].pivot, offset = model.hinges[0].offset;
const worldOf = (local) => { model.scene.updateMatrixWorld(true); return new THREE.Vector3(...local).applyMatrix4(sash.matrixWorld); };
/** Expected world position of the sash bottom point when open by ANGLE about +X through pivot p (deformed coords). */
const openExpected = (pt, p) => {
  const ry = pt[1] - p[1], rz = pt[2] - p[2];
  return [pt[0], p[1] + ry * Math.cos(ANGLE) - rz * Math.sin(ANGLE), p[2] + ry * Math.sin(ANGLE) + rz * Math.cos(ANGLE)];
};
const nearVec = (v, e, tol = 1e-6) => near(v.x, e[0], tol) && near(v.y, e[1], tol) && near(v.z, e[2], tol);
const fmt = (v) => `[${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)}]`;

// ---------- rest and open at the reference size ----------
check(nearVec(worldOf(SASH_BOTTOM), SASH_BOTTOM, 1e-12), 'rest: pivot and offset cancel, sash sits at its reference coordinates');
model.play('Sash_Hinge');
model.update(3.5);
{
  const v = worldOf(SASH_BOTTOM), e = openExpected(SASH_BOTTOM, P);
  check(nearVec(v, e), `open: bottom rail at ${fmt(v)}, expected [${e.map((x) => x.toFixed(5)).join(', ')}]`);
  check(v.z > SASH_BOTTOM[2] + 0.3, 'open: bottom rail swings outward (+Z), opens "outward"');
  check(nearVec(worldOf([W / 2, P[1], P[2]]), [W / 2, P[1], P[2]], 1e-9), 'open: points on the hinge axis do not move');
}
model.stop();
check(nearVec(worldOf(SASH_BOTTOM), SASH_BOTTOM, 1e-12) && pivot.quaternion.w === 1, 'stop: exact rest pose');

// ---------- resize: the head hinge follows the head ----------
const dW = 0.2, dH = 0.3;
model.setSize(W + dW, H + dH);
check(pivot.position.x === P[0] && near(pivot.position.y, P[1] + dH, 1e-12) && pivot.position.z === P[2], 'resize: pivot moves up with the head (pivotFactor.y = 1), x and z unchanged');
check(pivot.position.clone().add(offset.position).lengthSq() === 0, 'resize: offset is exactly −pivot');
{
  const sashBox = new THREE.Box3().setFromObject(sash);
  check(near(sashBox.max.y, H - T + dH, 1e-6) && near(sashBox.min.y, T, 1e-6) && near(sashBox.max.x, W - T + dW, 1e-6), 'resize: closed sash spans the new opening');
  model.play('Sash_Hinge');
  model.update(3.5);
  const Pn = [P[0], P[1] + dH, P[2]];
  const v = worldOf(SASH_BOTTOM), e = openExpected(SASH_BOTTOM, Pn);
  check(nearVec(v, e), `resized open: bottom rail at ${fmt(v)}, expected [${e.map((x) => x.toFixed(5)).join(', ')}] (taller sash swings further out)`);
}

// ---------- resize while open, then close ----------
model.stop();
model.play('Sash_Hinge');
model.update(1.5);
const qMid = pivot.quaternion.clone();
model.setSize(W, H);
check(model.clips[0].action.isScheduled() && near(model.clips[0].action.time, 1.5, 1e-9), 'resize while open: action resumed at the same time');
check(Math.abs(pivot.quaternion.dot(qMid)) > 1 - 1e-12 && near(pivot.position.y, P[1], 1e-12), 'resize while open: same angle, pivot back at the reference head');
model.stop();
check(nearVec(worldOf(SASH_BOTTOM), SASH_BOTTOM, 1e-12), 'close after resize: exact reference rest pose');

// ---------- a single awning in the multi-window assembly (no extension: front at z = 0) ----------
{
  const a = new WindowAssembly();
  const m = new WindowModel(build());
  const id = a.add(m, { w: W / 0.0254, h: H / 0.0254, type: { key: 'awning-test', label: 'Awning (test)' }, colors: {} });
  check(a.depthOffset_m(id) === 0, 'assembly: synthetic awning (no extension) placed at z = 0');
  a.dispose();
}

// ---------- refusals ----------
console.log('awning refusals');
refused({ hinge: { hingeSide: 'left' } }, /hingeSide must be top\|bottom for axis "x"/, 'axis x with hingeSide left is refused');
refused({ hinge: { axis: 'z' } }, /axis must be "y" .* or "x"/, 'axis z is refused');
refused({ hinge: { axis: 'y', hingeSide: 'top' } }, /hingeSide must be left\|right for axis "y"/, 'axis y with hingeSide top is refused');
refused({ rotAxis: new THREE.Vector3(0, 1, 0) }, /does not rotate about the x axis/, 'clip rotating about Y on an x hinge is refused');
refused({ rotAxis: new THREE.Vector3(1, 0.05, 0).normalize() }, /does not rotate about the x axis/, 'clip rotating about a tilted axis is refused');
refused({ anim: { axis: 'y' } }, /root animation axis "y" differs from hinge Sash_Hinge axis "x"/, 'root animation axis differing from the hinge axis is refused');
check(errorsOf({ hinge: { hingeSide: 'bottom', opens: 'inward' } }).length === 0, 'hopper form (axis x, hingeSide bottom, inward) passes the schema');

// ---------- quaternionAxisError (pure) ----------
check(quaternionAxisError([0, 0, 0, 1], 'x') === null && quaternionAxisError([0, 0.5, 0, 0.866], 'y') === null, 'identity and pure-axis keys pass');
check(quaternionAxisError([0, 0.5, 0, 0.866], 'x') !== null, 'a Y rotation fails an x-axis check');

console.log(failures ? `FAILED: ${failures} failed, ${passes} passed` : `OK: ${passes} checks passed`);
process.exit(failures ? 1 : 0);
