#!/usr/bin/env node
// Headless checks for the scenery wall (src/configurator/wall.js).
//   node tools/test-wall.mjs
// Face areas match wall minus openings, reveals follow the openings' outline (not shared edges between touching
// windows), every triangle is wound to its normal, the solid is closed, uvs are planar metres, bad input throws.

import { wallGeometry, WALL_GROUP } from '../src/configurator/wall.js';

let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log(`  FAIL ${msg}`); } };
// Positions are Float32, so areas carry ~1e-7 relative rounding.
const near = (a, b, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const IN = 0.0254;

function analyse(g) {
  const area = [0, 0, 0];
  let wound = true;
  const edges = new Map();
  const P = (i) => [g.position[i * 3], g.position[i * 3 + 1], g.position[i * 3 + 2]];
  const key = (p) => p.map((v) => v.toFixed(9)).join(',');
  for (const gr of g.groups) {
    for (let t = gr.start; t < gr.start + gr.count; t += 3) {
      const [a, b, c] = [P(t), P(t + 1), P(t + 2)];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(...n);
      area[gr.materialIndex] += len / 2;
      const N = [g.normal[t * 3], g.normal[t * 3 + 1], g.normal[t * 3 + 2]];
      if (!(len > 0) || n[0] * N[0] + n[1] * N[1] + n[2] * N[2] <= 0) wound = false;
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const k = [key(p), key(q)].sort().join('|');
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
  }
  return { area, wound, edges };
}

/**
 * Closed solid: on every plane of the wall, the triangle edges of one face meet those of its neighbours. Because the
 * faces are cut on one shared grid, each undirected edge is used an even number of times (2 across a fold or inside a
 * quad; 4 where two coplanar quads meet along a grid line, two triangles from each). An odd count is a hole.
 */
const closed = (edges) => [...edges.values()].every((n) => n % 2 === 0);

// ---- one opening ----
console.log('one opening');
{
  const T = 8.229 * IN;
  const hole = { x: 0, y: 0.762, w: 24 * IN, h: 36 * IN };
  const outer = { x0: -3, y0: 0, x1: 3 + hole.w, y1: 3 };
  const g = wallGeometry([hole], outer, -T, 0);
  const { area, wound, edges } = analyse(g);
  const W = outer.x1 - outer.x0, H = outer.y1 - outer.y0;
  const faceArea = W * H - hole.w * hole.h;
  // exterior and interior groups hold one face each
  check(near(area[WALL_GROUP.exterior], faceArea), `exterior area ${area[0]} vs ${faceArea}`);
  check(near(area[WALL_GROUP.interior], faceArea), `interior area ${area[1]} vs ${faceArea}`);
  const revealArea = (2 * (hole.w + hole.h) + 2 * (W + H)) * T; // opening reveals + outer edges
  check(near(area[WALL_GROUP.reveal], revealArea), `reveal + edge area ${area[2]} vs ${revealArea}`);
  check(wound, 'every triangle is wound counter-clockwise toward its normal');
  check(closed(edges), 'wall is a closed solid');
  check(g.groups.map((x) => x.materialIndex).join() === '0,1,2', 'three material groups in order');
  check(g.position.length / 3 === g.groups.reduce((s, x) => s + x.count, 0), 'groups cover every vertex');
  // uv: exterior face uses (x, y) in metres
  const i0 = g.groups[0].start;
  check(g.uv[i0 * 2] === g.position[i0 * 3] && g.uv[i0 * 2 + 1] === g.position[i0 * 3 + 1], 'exterior uv is world x, y');
  check(g.normal.every((v) => v === 0 || v === 1 || v === -1), 'normals are axis-aligned unit vectors');
  // No geometry inside the opening's footprint on the faces.
  let faceInHole = false;
  for (const gr of g.groups.filter((x) => x.materialIndex !== WALL_GROUP.reveal)) {
    for (let t = gr.start; t < gr.start + gr.count; t += 3) {
      const cx = (g.position[t * 3] + g.position[t * 3 + 3] + g.position[t * 3 + 6]) / 3;
      const cy = (g.position[t * 3 + 1] + g.position[t * 3 + 4] + g.position[t * 3 + 7]) / 3;
      if (cx > hole.x && cx < hole.x + hole.w && cy > hole.y && cy < hole.y + hole.h) faceInHole = true;
    }
  }
  check(!faceInHole, 'no face covers the opening');
}

// ---- touching openings (grid of windows) ----
console.log('touching openings');
{
  const T = 0.2;
  // W1 24x36, W2 right of it 24x36, W3 above W2 24x36 (in metres via inches)
  const a = { x: 0, y: 1, w: 24 * IN, h: 36 * IN };
  const b = { x: a.w, y: 1, w: 24 * IN, h: 36 * IN };
  const c = { x: a.w, y: 1 + a.h, w: 24 * IN, h: 36 * IN };
  const outer = { x0: -2, y0: 0, x1: 4, y1: 5 };
  const g = wallGeometry([a, b, c], outer, -T, 0);
  const { area, wound, edges } = analyse(g);
  const W = outer.x1 - outer.x0, H = outer.y1 - outer.y0;
  check(near(area[0], W * H - 3 * a.w * a.h), 'exterior area = wall − three openings');
  // Outline of the union (an L): perimeter = 2 × (total width + total height) for this staircase shape.
  const unionPerimeter = 2 * (2 * a.w + 2 * a.h);
  check(near(area[2], (unionPerimeter + 2 * (W + H)) * T), `reveals follow the union outline only (${area[2]})`);
  check(wound && closed(edges), 'wound and closed');
}

// ---- input checks ----
console.log('input checks');
{
  const outer = { x0: 0, y0: 0, x1: 2, y1: 2 };
  check(throws(() => wallGeometry([], outer, 0, 0)), 'zero thickness throws');
  check(throws(() => wallGeometry([], outer, 0.1, 0)), 'inverted faces throw');
  check(throws(() => wallGeometry([{ x: 1.5, y: 0.5, w: 1, h: 1 }], outer, -0.2, 0)), 'opening outside the wall throws');
  check(throws(() => wallGeometry([], { x0: 1, y0: 0, x1: 1, y1: 2 }, -0.2, 0)), 'empty outline throws');
  const plain = analyse(wallGeometry([], outer, -0.2, 0));
  check(near(plain.area[0], 4) && near(plain.area[1], 4) && near(plain.area[2], 8 * 0.2), 'wall without openings is a plain slab');
}

console.log(failures ? `FAILED: ${failures} failed, ${passes} passed` : `OK: ${passes} checks passed`);
process.exit(failures ? 1 : 0);
