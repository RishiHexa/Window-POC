#!/usr/bin/env node
// Validates a configurator GLB (extras.cfg userData). No dependencies.
//
//   node tools/validate-glb.mjs <cfg.glb> [--original <Window_V3.glb>]
//
// With --original, it also checks the additive-only rules: same nodes, hierarchy and transforms;
// original extras preserved; animations byte-identical; per-mesh POSITION bbox and triangle count unchanged.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_SCHEMA, PART_SCHEMA, GROUP_SCHEMA, validateNodeCfg } from '../src/configurator/schema.js';
import { collapseDelta } from '../src/configurator/deform.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args[0];
const origIdx = args.indexOf('--original');
const originalFile = origIdx >= 0 ? args[origIdx + 1] : resolve(here, '../../glb/Window_V3.glb');
if (!file) { console.error('usage: validate-glb.mjs <cfg.glb> [--original <orig.glb>]'); process.exit(2); }

function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${path}: not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binHeader = 20 + jsonLen;
  const bin = binHeader < buf.length ? buf.subarray(binHeader + 8, binHeader + 8 + buf.readUInt32LE(binHeader)) : Buffer.alloc(0);
  return { json, bin };
}

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const CTYPE = { 5126: [4, 'readFloatLE'], 5125: [4, 'readUInt32LE'], 5123: [2, 'readUInt16LE'], 5121: [1, 'readUInt8'] };
function readAccessor({ json, bin }, index) {
  const a = json.accessors[index];
  const n = COMPS[a.type];
  const [size, fn] = CTYPE[a.componentType];
  const bv = json.bufferViews[a.bufferView];
  const stride = bv.byteStride || n * size;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * n);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = bin[fn](base + i * stride + k * size);
  return out;
}
function triangleCount(glb, prim) {
  if (prim.mode !== undefined && prim.mode !== 4) return NaN;
  return prim.indices !== undefined ? glb.json.accessors[prim.indices].count / 3 : glb.json.accessors[prim.attributes.POSITION].count / 3;
}

const errors = [];
const warnings = [];
const info = [];
const glb = readGlb(file);
const { json } = glb;
const nodes = json.nodes || [];

// ---- 1. cfg presence + schema on every node
let root = null;
for (const n of nodes) {
  const cfg = n.extras?.cfg;
  if (!cfg) { errors.push(`${n.name}: missing extras.cfg`); continue; }
  errors.push(...validateNodeCfg(n.name, cfg));
  if (cfg.schema === ROOT_SCHEMA) { if (root) errors.push(`multiple root cfg nodes`); root = n; }
  if (n.mesh !== undefined && cfg.schema !== PART_SCHEMA) errors.push(`${n.name}: mesh node must use ${PART_SCHEMA}`);
  if (n.mesh === undefined && cfg.schema === PART_SCHEMA) errors.push(`${n.name}: ${PART_SCHEMA} on a node without a mesh`);
  for (const key of ['translation', 'rotation', 'scale', 'matrix']) {
    if (n[key] !== undefined && cfg.schema !== GROUP_SCHEMA) warnings.push(`${n.name}: has explicit ${key}; configurator requires identity`);
  }
}
if (!root) errors.push(`no node with extras.cfg.schema = ${ROOT_SCHEMA}`);

// ---- 2. split planes vs real vertices, geometric limits
const meshNodes = nodes.filter((n) => n.mesh !== undefined && n.extras?.cfg?.schema === PART_SCHEMA);
let minDW = -Infinity, minDH = -Infinity;
const MIN_CLEARANCE_M = 0.002;
for (const n of meshNodes) {
  const cfg = n.extras.cfg;
  const prims = json.meshes[n.mesh].primitives;
  const all = [];
  for (const p of prims) all.push(...readAccessor(glb, p.attributes.POSITION));
  const pos = Float64Array.from(all);
  for (const [axisName, comp] of [['x', 0], ['y', 1]]) {
    const ax = cfg[axisName];
    if (!ax || ax.below === ax.above) continue;
    let nearest = Infinity;
    for (let i = comp; i < pos.length; i += 3) nearest = Math.min(nearest, Math.abs(pos[i] - ax.split_m));
    if (nearest < MIN_CLEARANCE_M) errors.push(`${n.name}.${axisName}: split_m ${ax.split_m} is ${(nearest * 1000).toFixed(2)} mm from a vertex (need >= ${MIN_CLEARANCE_M * 1000} mm)`);
    const d = collapseDelta(pos, ax, comp);
    if (d === -Infinity) errors.push(`${n.name}.${axisName}: marked stretchable but all vertices are on one side of split_m`);
    if (axisName === 'x') minDW = Math.max(minDW, d); else minDH = Math.max(minDH, d);
  }
  // Part B: material zone tags
  for (const p of prims) {
    const mat = json.materials?.[p.material];
    const z = mat?.extras?.cfg?.colorZone;
    if (z && !['exterior', 'interior'].includes(z)) errors.push(`material ${mat.name}: bad colorZone ${z}`);
  }
}
if (root) {
  const r = root.extras.cfg.reference;
  info.push(`geometric min width  ${((r.width_m + minDW) / 0.0254).toFixed(2)} in (${((r.width_m + minDW) * 1000).toFixed(1)} mm)`);
  info.push(`geometric min height ${((r.height_m + minDH) / 0.0254).toFixed(2)} in (${((r.height_m + minDH) * 1000).toFixed(1)} mm)`);
  for (const a of root.extras.cfg.animations || []) {
    const anim = (json.animations || []).find((x) => x.name === a.clip);
    if (!anim) errors.push(`root animations: clip "${a.clip}" not found`);
    else if (!anim.channels.some((c) => nodes[c.target.node]?.name === a.node && c.target.path === 'translation')) {
      errors.push(`root animations: clip "${a.clip}" does not translate node "${a.node}"`);
    }
  }
}
const splitMats = (json.materials || []).filter((m) => m.extras?.cfg?.colorZone);
info.push(splitMats.length ? `Part B present: ${splitMats.map((m) => `${m.name}=${m.extras.cfg.colorZone}`).join(', ')}` : 'Part B not present: colours will apply per part (node cfg.colorZone)');

// ---- 3. additive-only comparison with the original
let orig = null;
try { orig = readGlb(originalFile); } catch { warnings.push(`original not readable at ${originalFile}; skipped preservation checks`); }
if (orig) {
  const on = orig.json.nodes;
  if (on.length !== nodes.length) errors.push(`node count ${nodes.length} != original ${on.length}`);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const nameOf = (list, idxs) => JSON.stringify((idxs || []).map((i) => list[i].name));
  for (const o of on) {
    const n = byName.get(o.name);
    if (!n) { errors.push(`node ${o.name} missing`); continue; }
    if (nameOf(on, o.children) !== nameOf(nodes, n.children)) errors.push(`${o.name}: children changed`);
    for (const key of ['translation', 'rotation', 'scale', 'matrix']) {
      if (JSON.stringify(o[key]) !== JSON.stringify(n[key])) errors.push(`${o.name}: ${key} changed`);
    }
    for (const [k, v] of Object.entries(o.extras || {})) {
      if (JSON.stringify(n.extras?.[k]) !== JSON.stringify(v)) errors.push(`${o.name}: original extras.${k} changed or removed`);
    }
    if (o.mesh !== undefined) {
      const op = orig.json.meshes[o.mesh].primitives, np = json.meshes[n.mesh].primitives;
      const ot = op.reduce((s, p) => s + triangleCount(orig, p), 0), nt = np.reduce((s, p) => s + triangleCount(glb, p), 0);
      if (ot !== nt) errors.push(`${o.name}: triangle count ${nt} != original ${ot}`);
      const box = (g, prims) => {
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (const p of prims) { const a = g.json.accessors[p.attributes.POSITION]; for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], a.min[k]); mx[k] = Math.max(mx[k], a.max[k]); } }
        return [...mn, ...mx];
      };
      const ob = box(orig, op), nb = box(glb, np);
      if (ob.some((v, i) => Math.abs(v - nb[i]) > 1e-7)) errors.push(`${o.name}: POSITION bbox changed`);
    }
  }
  for (const oa of orig.json.animations || []) {
    const na = (json.animations || []).find((a) => a.name === oa.name);
    if (!na) { errors.push(`animation ${oa.name} missing`); continue; }
    oa.samplers.forEach((s, i) => {
      const ns = na.samplers[i];
      const same = (x, y) => { const a = readAccessor(orig, x), b = readAccessor(glb, y); return a.length === b.length && a.every((v, k) => v === b[k]); };
      if (!ns || s.interpolation !== ns.interpolation || !same(s.input, ns.input) || !same(s.output, ns.output)) errors.push(`animation ${oa.name} sampler ${i} changed`);
    });
  }
  if (JSON.stringify(orig.json.extensionsUsed?.slice().sort()) !== JSON.stringify(json.extensionsUsed?.slice().sort())) {
    warnings.push(`extensionsUsed differs: ${JSON.stringify(orig.json.extensionsUsed)} -> ${JSON.stringify(json.extensionsUsed)}`);
  }
}

// ---- report
console.log(`Validated ${file}`);
console.log(`  nodes: ${nodes.length}, mesh parts: ${meshNodes.length}, animations: ${(json.animations || []).length}`);
info.forEach((m) => console.log(`  info: ${m}`));
warnings.forEach((m) => console.log(`  WARN: ${m}`));
errors.forEach((m) => console.log(`  ERROR: ${m}`));
console.log(errors.length ? `FAILED (${errors.length} error(s))` : 'OK');
process.exit(errors.length ? 1 : 0);
