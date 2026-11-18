// Multi-window layout. Pure functions (no three.js, no Vue), unit-testable in Node.
// PRESENTATION ONLY: positions and sizes here drive the visual preview. They are not order, mulling or
// manufacturing dimensions, and the joint between two windows (mullion / coupler / mull cover) is NOT modelled,
// because there is no documented data for it. Windows are drawn butted frame to frame.
//
// A layout is a list of windows, in inches:
//   { id, parent, side, w, h }
//     parent = id of the window it was added to (null for the first window)
//     side   = which side of the parent it sits on: 'left' | 'right' | 'top' | 'bottom' (null for the first window)
//
// Each window keeps its own width and height. Its position is derived from its parent, every time:
//   right  of P: x = P.x + P.w   y = P.y          (bottoms aligned)
//   left   of P: x = P.x − w     y = P.y          (bottoms aligned)
//   top    of P: x = P.x         y = P.y + P.h    (left edges aligned)
//   bottom of P: x = P.x         y = P.y − h      (left edges aligned)
// The first window's bottom-left corner is the origin. Because positions are derived, resizing a window moves the
// windows attached to it, and nothing is stored that could drift.
//
// Windows must never overlap. Touching edges is fine. Any add or resize that would overlap is blocked, never clamped.

export const SIDES = ['left', 'right', 'top', 'bottom'];

// Overlap tolerance (in). Far finer than the 1/8 in input step and the 0.001 in the UI shows. It only absorbs float
// noise from typed decimals (24.3 + 30.1 = 54.400000000000006).
const EPS_IN = 1e-6;

/** Rectangle of a window placed on `side` of `parent` (a rectangle). */
export function placeOn(parent, side, w, h) {
  switch (side) {
    case 'right': return { x: parent.x + parent.w, y: parent.y, w, h };
    case 'left': return { x: parent.x - w, y: parent.y, w, h };
    case 'top': return { x: parent.x, y: parent.y + parent.h, w, h };
    case 'bottom': return { x: parent.x, y: parent.y - h, w, h };
    default: throw new RangeError(`Unknown side "${side}"`);
  }
}

/**
 * Rectangles for every window: Map id → { x, y, w, h } (inches, bottom-left corner).
 * Throws if the tree is broken (missing parent, cycle, more than one root). That is a programming error, not a
 * user input problem, so it is never patched over.
 */
export function placeAll(units) {
  const byId = new Map(units.map((u) => [u.id, u]));
  if (byId.size !== units.length) throw new Error('Duplicate window id');
  const roots = units.filter((u) => u.parent == null);
  if (roots.length !== 1) throw new Error(`Layout needs exactly one first window, found ${roots.length}`);
  const rects = new Map();
  const visiting = new Set();
  const place = (u) => {
    if (rects.has(u.id)) return rects.get(u.id);
    if (visiting.has(u.id)) throw new Error(`Window ${u.id}: attachment cycle`);
    visiting.add(u.id);
    let r;
    if (u.parent == null) r = { x: 0, y: 0, w: u.w, h: u.h };
    else {
      const p = byId.get(u.parent);
      if (!p) throw new Error(`Window ${u.id}: parent ${u.parent} does not exist`);
      r = placeOn(place(p), u.side, u.w, u.h);
    }
    visiting.delete(u.id);
    rects.set(u.id, r);
    return r;
  };
  units.forEach(place);
  return rects;
}

/** True if two rectangles share area (touching edges do not count). */
export function overlaps(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS_IN
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS_IN;
}

/** First overlapping pair as [idA, idB], or null. */
export function findOverlap(rects) {
  const list = [...rects];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) if (overlaps(list[i][1], list[j][1])) return [list[i][0], list[j][0]];
  }
  return null;
}

/** Overall extents of the layout (in): { minX, minY, maxX, maxY, w, h }. */
export function extents(rects) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects.values()) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * Can a w × h window be added on `side` of window `parentId`? Returns { ok, reason, rect }.
 * The new window must not overlap any existing window.
 */
export function checkAdd(units, parentId, side, w, h) {
  if (!SIDES.includes(side)) return { ok: false, reason: `Unknown side "${side}"` };
  const rects = placeAll(units);
  const p = rects.get(parentId);
  if (!p) return { ok: false, reason: `Window ${parentId} does not exist` };
  const rect = placeOn(p, side, w, h);
  for (const [id, r] of rects) if (overlaps(rect, r)) return { ok: false, reason: `It would overlap window ${id}`, overlapId: id, rect };
  return { ok: true, reason: '', rect };
}

/** Can window `id` be resized to w × h? Windows attached to it move with it; none may end up overlapping. */
export function checkResize(units, id, w, h) {
  if (!units.some((u) => u.id === id)) return { ok: false, reason: `Window ${id} does not exist` };
  const next = units.map((u) => (u.id === id ? { ...u, w, h } : u));
  const hit = findOverlap(placeAll(next));
  return hit ? { ok: false, reason: `Windows ${hit[0]} and ${hit[1]} would overlap`, overlapIds: hit } : { ok: true, reason: '' };
}

/** Windows attached directly to `id`. */
export const childrenOf = (units, id) => units.filter((u) => u.parent === id);

/**
 * Can window `id` be removed? Allowed for a window nothing is attached to, and for the first window when exactly one
 * window is attached to it (that one becomes the first window; nothing moves relative to it). Any other removal would
 * leave windows without a position, so it is blocked rather than guessing where they should go.
 */
export function checkRemove(units, id) {
  const u = units.find((x) => x.id === id);
  if (!u) return { ok: false, reason: `Window ${id} does not exist` };
  if (units.length <= 1) return { ok: false, reason: 'The last window cannot be removed' };
  const kids = childrenOf(units, id);
  if (kids.length === 0) return { ok: true, reason: '' };
  if (u.parent == null && kids.length === 1) return { ok: true, reason: '', newRoot: kids[0].id };
  return { ok: false, reason: `Remove the windows attached to it first (${kids.map((k) => k.id).join(', ')})`, blockers: kids.map((k) => k.id) };
}

/**
 * The layout after removing `id` (checkRemove must allow it). Returns a new array. When the first window is removed,
 * its only attached window becomes the first window; the rest keep their attachments, so their positions relative to
 * it are unchanged (the whole layout shifts so the new first window sits at the origin).
 */
export function removeFrom(units, id) {
  const c = checkRemove(units, id);
  if (!c.ok) throw new RangeError(c.reason);
  return units
    .filter((u) => u.id !== id)
    .map((u) => (u.id === c.newRoot ? { ...u, parent: null, side: null } : u));
}
