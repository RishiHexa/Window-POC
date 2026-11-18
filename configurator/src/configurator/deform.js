// Split-plane stretch. Pure functions on Float32Arrays (no three.js), unit-testable in Node.
//
//   x' = x + dW * (x < cfg.x.split_m ? cfg.x.below : cfg.x.above)
//   y' = y + dH * (y < cfg.y.split_m ? cfg.y.below : cfg.y.above)
//   z' = z
//
// Every vertex is translated rigidly, by one of two amounts. That keeps mitre angles
// and profile cross-sections exact. Only the length between the two vertex sets changes.
// VISUAL ONLY: these positions are never a source of manufacturing dimensions.

export function axisOffset(value, axis, delta) {
  return delta * (value < axis.split_m ? axis.below : axis.above);
}

/** Writes deformed positions into `out` (same length as `ref`, xyz triplets). */
export function deformPositions(ref, out, cfg, dW, dH) {
  const { x, y } = cfg;
  for (let i = 0; i < ref.length; i += 3) {
    out[i] = ref[i] + axisOffset(ref[i], x, dW);
    out[i + 1] = ref[i + 1] + axisOffset(ref[i + 1], y, dH);
    out[i + 2] = ref[i + 2];
  }
  return out;
}

/**
 * Most negative delta before the two vertex sets of a stretching part would meet
 * (the geometry would invert). Returns -Infinity for parts that do not stretch on that axis.
 */
export function collapseDelta(ref, axis, component) {
  const k = axis.above - axis.below;
  if (k === 0) return -Infinity;
  let maxBelow = -Infinity;
  let minAbove = Infinity;
  for (let i = component; i < ref.length; i += 3) {
    const v = ref[i];
    if (v < axis.split_m) { if (v > maxBelow) maxBelow = v; } else if (v < minAbove) minAbove = v;
  }
  if (!Number.isFinite(maxBelow) || !Number.isFinite(minAbove)) return -Infinity; // all vertices on one side → rigid
  const gap = minAbove - maxBelow;
  // gap + delta * k must stay > 0
  if (k < 0) throw new Error('above < below is not supported (part would shrink as the window grows)');
  return -gap / k;
}

/**
 * Smallest delta for which a rigid part (moves by delta * factor, never stretches) still lies inside the
 * window's outside edges [0, size + delta] on one axis. -Infinity when it fits at any size.
 * A constraint already violated at the reference size cannot be fixed by resizing and is not reported.
 */
export function rigidFitDelta(lo, hi, factor, size) {
  let d = -Infinity;
  if (factor > 0) d = Math.max(d, -lo / factor);              // lo + factor * delta >= 0
  if (factor < 1) d = Math.max(d, (hi - size) / (1 - factor)); // hi + factor * delta <= size + delta
  return d;
}

/** Scale factor for a sash travel animation after a height change. */
export function travelFactor(anim, dH) {
  return (anim.referenceTravel_m + anim.travelPerDeltaHeight * dH) / anim.referenceTravel_m;
}

export const M_PER_IN = 0.0254;
export const inToM = (inch) => inch * M_PER_IN;
export const mToIn = (m) => m / M_PER_IN;
