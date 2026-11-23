#!/usr/bin/env node
// Checks for the procedural PVC surface-detail texture (src/configurator/surfaceDetail.js). Presentation only.
//   node tools/test-surface.mjs
// The pattern must be identical on every load (deterministic), use its full range, and tile without a seam:
// the step across the wrap-around edge must be no larger than the steps between neighbours inside the texture.

import { surfaceDetailData, SURFACE_DETAIL } from '../src/configurator/surfaceDetail.js';

let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) passes++; else { failures++; console.log(`  FAIL ${msg}`); } };

const N = SURFACE_DETAIL.size;
const a = surfaceDetailData(N), b = surfaceDetailData(N);
check(a.length === N * N * 4, `size ${N} x ${N} RGBA`);
check(a.every((v, i) => v === b[i]), 'deterministic: two generations are byte-identical');

for (const [ch, name] of [[0, 'height (R)'], [1, 'roughness (G)']]) {
  const px = (x, y) => a[(y * N + x) * 4 + ch];
  let lo = 255, hi = 0, inner = 0, seam = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = px(x, y); lo = Math.min(lo, v); hi = Math.max(hi, v);
      if (x < N - 1) inner = Math.max(inner, Math.abs(v - px(x + 1, y)));
      if (y < N - 1) inner = Math.max(inner, Math.abs(v - px(x, y + 1)));
    }
    seam = Math.max(seam, Math.abs(px(N - 1, y) - px(0, y)), Math.abs(px(y, N - 1) - px(y, 0)));
  }
  check(lo === 0 && hi === 255, `${name}: uses the full range (${lo}..${hi})`);
  check(seam <= inner, `${name}: tiles without a seam (max edge step ${seam} <= max inner step ${inner})`);
}
check(a.every((v, i) => i % 4 !== 3 || v === 255), 'alpha is opaque');

console.log(failures ? `FAILED: ${failures} failed, ${passes} passed` : `OK: ${passes} checks passed`);
process.exit(failures ? 1 : 0);
