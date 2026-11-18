#!/usr/bin/env node
// Parts B + C for the casement: add extras.cfg (merged, never replacing extras) and split PVC into
// PVC_Exterior / PVC_Interior by face normal. Input glb/Casement_V1.glb -> output glb/Casement_V1_cfg.glb.
//
//   npm i @gltf-transform/core@4 @gltf-transform/extensions@4
//   node prompts/build-casement-cfg.mjs glb/Casement_V1.glb glb/Casement_V1_cfg.glb
//
// Visual preview only. Nothing here is manufacturing data.
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';

const [IN, OUT] = process.argv.slice(2);
if (!IN || !OUT) { console.error('usage: build-casement-cfg.mjs <in.glb> <out.glb>'); process.exit(2); }
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const doc = await io.read(IN);
const root = doc.getRoot();
const fail = (m) => { console.error('STOP: ' + m); process.exit(1); };

const W0 = 0.6096, H0 = 0.9144, XS = 0.3048, YS = 0.4572;
const FACT = {           // side: [x.below, x.above, y.below, y.above]
  left:   [0, 0, 0, 1],
  right:  [1, 1, 0, 1],
  top:    [0, 1, 1, 1],
  bottom: [0, 1, 0, 0],
  infill: [0, 1, 0, 1],
};

const nodes = root.listNodes();
const byName = new Map(nodes.map((n) => [n.getName(), n]));
const meshNodes = nodes.filter((n) => n.getMesh());

// ---- pre-checks (state before Part C)
for (const n of meshNodes) {
  const prims = n.getMesh().listPrimitives();
  if (prims.length !== 1) fail(`${n.getName()}: ${prims.length} primitives before Part C`);
  if (prims[0].getMode() !== 4) fail(`${n.getName()}: mode ${prims[0].getMode()}`);
}
const meshUse = new Map();
for (const n of meshNodes) { const m = n.getMesh(); if (meshUse.has(m)) fail(`mesh shared by ${n.getName()} and ${meshUse.get(m)}`); meshUse.set(m, n.getName()); }

const posArray = (prim) => prim.getAttribute('POSITION').getArray();
function bboxOf(prims) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) { const a = posArray(p); for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a[i + k]); mx[k] = Math.max(mx[k], a[i + k]); } }
  return { mn, mx };
}

// ---- classify parts
function partInfo(n) {
  const name = n.getName();
  const ex = n.getExtras();
  const mat = n.getMesh().listPrimitives()[0].getMaterial().getName();
  const role = mat === 'Glass_IGU' ? 'glass' : mat === 'Glazing_Tape' ? 'gasket' : mat === 'Hardware_Metal' ? 'hardware' : 'profile';
  const side = ex.side;
  if (!FACT[side]) fail(`${name}: side "${side}" not known`);
  let assembly = ex.assembly;
  if (role === 'glass' || role === 'gasket') assembly = 'Sash';            // glass and tape use Sash (prompt B1)
  if (!['Frame', 'FrameAccessory', 'Extension', 'Sash', 'Bead', 'Hinge'].includes(assembly)) fail(`${name}: assembly ${assembly}`);
  return { name, role, side, assembly, provenanceAssembly: ex.assembly };
}
const parts = meshNodes.map((n) => ({ node: n, ...partInfo(n) }));

// ---- colorZone per assembly (profile parts): z_mid over all profile parts of the assembly vs Frame
function zRange(list) {
  let lo = Infinity, hi = -Infinity;
  for (const p of list) { const b = bboxOf(p.node.getMesh().listPrimitives()); lo = Math.min(lo, b.mn[2]); hi = Math.max(hi, b.mx[2]); }
  return [lo, hi];
}
const zone = {}, zinfo = {};
const [fl, fh] = zRange(parts.filter((p) => p.assembly === 'Frame' && p.role === 'profile'));
const Zframe = (fl + fh) / 2;
for (const a of [...new Set(parts.filter((p) => p.role === 'profile').map((p) => p.assembly))]) {
  const [lo, hi] = zRange(parts.filter((p) => p.assembly === a && p.role === 'profile'));
  const zmid = (lo + hi) / 2;
  zone[a] = zmid >= Zframe ? 'exterior' : 'interior';
  // also over every part (incl. glass/tape) carrying this cfg assembly, for the report
  const [lo2, hi2] = zRange(parts.filter((p) => p.assembly === a));
  zinfo[a] = { z_min: lo, z_max: hi, z_mid: zmid, z_mid_all_parts: (lo2 + hi2) / 2, zone: zone[a] };
}
zinfo.Z_frame = Zframe;

// ---- split clearance (stop if any stretching split is < 10 mm from a vertex or has no vertices on one side)
const clearance = [];
const factOf = (p) => p.role === 'hardware' ? (p.side === 'top' ? [0, 0, 1, 1] : [0, 0, 0, 0]) : FACT[p.side]; // hardware is rigid
for (const p of parts) {
  const [xb, xa, yb, ya] = factOf(p);
  const a = posArray(p.node.getMesh().listPrimitives()[0]);
  for (const [axis, comp, split, below, above] of [['x', 0, XS, xb, xa], ['y', 1, YS, yb, ya]]) {
    if (below === above) continue;
    let near = Infinity, lo = 0, hi = 0;
    for (let i = comp; i < a.length; i += 3) { near = Math.min(near, Math.abs(a[i] - split)); if (a[i] < split) lo++; else hi++; }
    clearance.push({ part: p.name, axis, split, nearest_mm: +(near * 1000).toFixed(3), below_count: lo, above_count: hi });
    if (near < 0.010) fail(`${p.name}.${axis}: split ${split} is ${(near * 1000).toFixed(3)} mm from a vertex`);
    if (!lo || !hi) fail(`${p.name}.${axis}: all vertices on one side of split ${split}`);
  }
}

// ---- Part B: merge cfg
const mergeCfg = (n, cfg) => n.setExtras({ ...n.getExtras(), cfg });
for (const p of parts) {
  const [xb, xa, yb, ya] = factOf(p);
  mergeCfg(p.node, {
    schema: 'davinci.window.part/1', role: p.role, assembly: p.assembly, side: p.side,
    canScaleX: xb !== xa, canScaleY: yb !== ya,
    x: { split_m: XS, below: xb, above: xa }, y: { split_m: YS, below: yb, above: ya },
    colorZone: p.role === 'glass' ? 'glass' : p.role === 'gasket' ? 'gasket' : p.role === 'hardware' ? 'hardware' : zone[p.assembly],
  });
}
const hasClose = root.listAnimations().some((a) => a.getName() === 'Sash_Hinge_Close');
const rootNode = byName.get(root.listScenes()[0].listChildren()[0].getName());
const rex = rootNode.getExtras();
const hinge = byName.get('Sash_Hinge'), offset = byName.get('Sash_HingeOffset');
if (!hinge || !offset) fail('hinge nodes missing');
const P = hinge.getTranslation();
const hingeSide = rex.hinge_side, opens = rex.opens;
if (!['left', 'right'].includes(hingeSide) || !['outward', 'inward'].includes(opens)) fail('root hinge_side/opens missing');
mergeCfg(hinge, {
  schema: 'davinci.window.hinge/1', role: 'hingePivot', assembly: 'Sash', clip: 'Sash_Hinge', ...(hasClose ? { closeClip: 'Sash_Hinge_Close' } : {}), offsetNode: 'Sash_HingeOffset',
  axis: 'y', pivot_m: [P[0], P[1], P[2]], pivotFactor: { x: hingeSide === 'left' ? 0 : 1, y: 0 },
  hingeSide, opens,
  hingeSide_source: (rex.hinge_hardware ? 'Hinge hardware: Truth #14.97 per Soniplastics p.21 (hinge on the plan-right jamb, viewed from above with interior at the bottom = left seen from exterior). ' : '') + 'DWG elevation of the 24x36 casement (x 0-24 in, layer PVC): swing-triangle lines meet at the drawing-left jamb ' +
    '(apex x=3.143 in). The DWG does not state the viewing side or the swing; the user confirmed on 2026-11-18 that the elevation ' +
    'is drawn from the exterior (=> left hinge) and that the sash opens outward.',
});
const hw = rex.hinge_hardware;   // present from Casement_V2 on (Truth 14.97 slider-crank)
if (hw) {
  const IN = 0.0254;
  hinge.setExtras({ ...hinge.getExtras(), cfg: { ...hinge.getExtras().cfg,
    motion: 'slider-crank',
    linkage: { model: hw.model, trackAxis: 'x', stud_m: hw.stud_in.map((v) => v * IN), shoeToJoint_m: hw.shoeToJoint_in * IN,
      supportArm_m: hw.supportArm_in * IN, shoeTravelAtOpen_m: hw.shoeTravel_in * IN,
      note: 'Clip keys hold absolute pivot translation at the reference size; add (dW*pivotFactor.x, dH*pivotFactor.y, 0) to every key. Shoe travel does not scale with size.',
      source: hw.source } } });
}
for (const n of nodes) {   // support-arm pivot/offset nodes (Casement_V3+)
  const nm = n.getName(); const m = /^Hinge_(Top|Bottom)_SupportArm_(Pivot|Offset)$/.exec(nm);
  if (!m) continue;
  const sideL = m[1].toLowerCase();
  mergeCfg(n, m[2] === 'Pivot'
    ? { schema: 'davinci.window.hinge/1', role: 'linkPivot', assembly: 'Hinge', side: sideL, clip: 'Sash_Hinge', axis: 'y',
        offsetNode: `Hinge_${m[1]}_SupportArm_Offset`, pivot_m: n.getTranslation(), pivotFactor: { x: hingeSide === 'left' ? 0 : 1, y: sideL === 'top' ? 1 : 0 } }
    : { schema: 'davinci.window.hinge/1', role: 'linkOffset', assembly: 'Hinge', side: sideL, pivotNode: `Hinge_${m[1]}_SupportArm_Pivot` });
}
mergeCfg(offset, { schema: 'davinci.window.hinge/1', role: 'hingeOffset', assembly: 'Sash', pivotNode: 'Sash_Hinge' });
mergeCfg(rootNode, {
  schema: 'davinci.window.cfg/1', units: 'm', windowType: 'casement',
  reference: { width_m: W0, height_m: H0, width_in: 24, height_in: 36 },
  axes: { width: 'x', height: 'y', depth: 'z', exteriorFacing: '+z' },
  colorZones: ['exterior', 'interior'],
  animations: [{ clip: 'Sash_Hinge', node: 'Sash_Hinge', motion: hw ? 'rotate+slide' : 'rotate', axis: 'y', openAngle_deg: 90,
    ...(hw ? { slideAxis: 'x', slideTravel_m: hw.shoeTravel_in * 0.0254 } : {}),
    openAngle_source: 'preview-only value chosen by user 2026-11-18; not product data', label: 'Sash' },
    ...(hasClose ? [{ clip: 'Sash_Hinge_Close', node: 'Sash_Hinge', motion: hw ? 'rotate+slide' : 'rotate', axis: 'y', openAngle_deg: 90, direction: 'close',
      ...(hw ? { slideAxis: 'x', slideTravel_m: hw.shoeTravel_in * 0.0254 } : {}),
      openAngle_source: 'preview-only value chosen by user 2026-11-18; not product data', label: 'Sash (close)' }] : [])],
});

// ---- Part C: split PVC
const pvc = root.listMaterials().find((m) => m.getName() === 'PVC_White');
if (!pvc) fail('PVC_White missing');
const mk = (name, z) => pvc.clone().setName(name).setExtras({ ...pvc.getExtras(), cfg: { colorZone: z } });
const matExt = mk('PVC_Exterior', 'exterior'), matInt = mk('PVC_Interior', 'interior');
const counts = [];
for (const p of parts) {
  const mesh = p.node.getMesh();
  const prim = mesh.listPrimitives()[0];
  if (prim.getMaterial() !== pvc) continue;
  const pos = posArray(prim), idx = prim.getIndices().getArray();
  const before = { box: bboxOf([prim]), tris: idx.length / 3, posCopy: Float32Array.from(pos) };
  const ext = [], int = [];
  const def = p.node.getExtras().cfg.colorZone;
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nzn = nz / Math.hypot(nx, ny, nz);
    const zoneT = nzn >= 0.5 ? 'exterior' : nzn <= -0.5 ? 'interior' : def;
    (zoneT === 'exterior' ? ext : int).push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const IdxCtor = idx.constructor;
  const make = (list, mat) => {
    const acc = doc.createAccessor().setType('SCALAR').setArray(new IdxCtor(list)).setBuffer(prim.getIndices().getBuffer());
    const np = doc.createPrimitive().setMode(4).setMaterial(mat).setIndices(acc);
    for (const sem of prim.listSemantics()) np.setAttribute(sem, prim.getAttribute(sem)); // shared vertex data
    return np;
  };
  const newPrims = [];
  if (ext.length) newPrims.push(make(ext, matExt));
  if (int.length) newPrims.push(make(int, matInt));
  mesh.removePrimitive(prim);
  newPrims.forEach((np) => mesh.addPrimitive(np));
  prim.dispose();
  // invariants
  const after = mesh.listPrimitives();
  const tris = after.reduce((s, q) => s + q.getIndices().getCount() / 3, 0);
  if (tris !== before.tris) fail(`${p.name}: triangle count changed`);
  const seen = new Set();
  const key = (i0, i1, i2) => `${i0},${i1},${i2}`;
  for (const q of after) { const a = q.getIndices().getArray(); for (let t = 0; t < a.length; t += 3) seen.add(key(a[t], a[t + 1], a[t + 2])); }
  for (let t = 0; t < idx.length; t += 3) if (!seen.has(key(idx[t], idx[t + 1], idx[t + 2]))) fail(`${p.name}: triangle lost`);
  const box = bboxOf(after);
  if ([0, 1, 2].some((k) => box.mn[k] !== before.box.mn[k] || box.mx[k] !== before.box.mx[k])) fail(`${p.name}: bbox changed`);
  const np0 = posArray(after[0]);
  if (np0.length !== before.posCopy.length || np0.some((v, i) => v !== before.posCopy[i])) fail(`${p.name}: vertex values changed`);
  counts.push({ part: p.name, before: before.tris, exterior: ext.length / 3, interior: int.length / 3 });
}
const stillUsed = root.listMeshes().some((m) => m.listPrimitives().some((q) => q.getMaterial() === pvc));
if (!stillUsed) pvc.dispose();

await io.write(OUT, doc);
console.log(JSON.stringify({ zones: zinfo, clearance, partC: counts, pvcWhiteRemoved: !stillUsed }, null, 1));
