// Exploded-view layout. VISUAL ONLY: offsets are applied to object transforms for presentation
// and never touch geometry, dimensions or any stored value.
//
// Each part moves  D × t × ( radial(side) × r  +  ẑ × depth ),  where
//   D = EXPLODE_SCALE × max(width, height)   (so the layout reads the same at any size)
//   t = 0 (assembled) … 1 (fully exploded)
//   +Z is the exterior (root cfg axes.exteriorFacing)
//
// Depth order follows the real stack-up in the GLB: the extension is the most interior. The lower
// sash goes to the interior, where its bead is exterior of its glass. The upper sash goes to the
// exterior, where its bead is the most exterior piece.

export const EXPLODE_SCALE = 0.3;

const RADIAL = { left: [-1, 0], right: [1, 0], bottom: [0, -1], top: [0, 1], infill: [0, 0] };

// [radial r, depth] per assembly/role. Glass and gasket follow their sash, slightly toward the glass.
const LAYOUT = {
  Extension: [0.55, -1.0],
  Frame: [0.35, 0.0],
  FrameAccessory: [0.15, 0.3],
  LowerSash: [0.2, -0.5],
  LowerSash_gasket: [0.2, -0.4],
  LowerSash_glass: [0.0, -0.3],
  LowerBead: [0.1, -0.15],
  UpperSash: [0.2, 0.5],
  UpperSash_gasket: [0.2, 0.6],
  UpperSash_glass: [0.0, 0.7],
  UpperBead: [0.1, 0.85],
};

/** Unit-free offset direction for a part (multiply by D and t). */
export function explodeDirection(cfg) {
  const key = cfg.role === 'glass' || cfg.role === 'gasket' ? `${cfg.assembly}_${cfg.role}` : cfg.assembly;
  const layout = LAYOUT[key];
  if (!layout) return [0, 0, 0]; // unknown assembly stays put rather than guessing a direction
  const [rx, ry] = RADIAL[cfg.side] ?? [0, 0];
  return [rx * layout[0], ry * layout[0], layout[1]];
}
