// Wall with window openings, as plain triangle arrays. Pure functions (no three.js), unit-testable in Node.
// PRESENTATION ONLY: the wall is scenery around the preview. It is not a rough opening, an installation detail or a
// source of any dimension. Openings are exactly the windows' frame outside rectangles, so frames butt the wall.
//
// Method: the wall face is cut into a grid by every window edge plus the wall's outer edges. A grid cell is solid
// unless its centre lies in a window. Every solid cell gets an exterior face (+z) and an interior face (−z). A side
// face is added only where a solid cell meets an opening (a reveal) or the wall's outer boundary (an edge), so there
// are no internal faces and the solid is closed. All coordinates are metres.

/** Material slots for the geometry groups. */
export const WALL_GROUP = { exterior: 0, interior: 1, reveal: 2 };

const uniq = (vals) => [...new Set(vals)].sort((a, b) => a - b);

/**
 * @param {{x:number,y:number,w:number,h:number}[]} holes  window rectangles (bottom-left corner), metres
 * @param {{x0:number,y0:number,x1:number,y1:number}} outer  wall outline; every hole must lie inside it
 * @param {number} zInt  interior face (z)
 * @param {number} zExt  exterior face (z), zExt > zInt (+z is the exterior)
 * @returns {{position:Float32Array, normal:Float32Array, uv:Float32Array, groups:{start:number,count:number,materialIndex:number}[]}}
 *   uv is planar world mapping in metres (x/y on the faces, z along reveals), so textures tile at true scale.
 */
export function wallGeometry(holes, outer, zInt, zExt) {
  if (!(zExt > zInt)) throw new RangeError('Wall exterior face must be in front of its interior face');
  if (!(outer.x1 > outer.x0 && outer.y1 > outer.y0)) throw new RangeError('Wall outline is empty');
  for (const h of holes) {
    if (h.x < outer.x0 || h.y < outer.y0 || h.x + h.w > outer.x1 || h.y + h.h > outer.y1) throw new RangeError('Opening lies outside the wall');
  }
  const xs = uniq([outer.x0, outer.x1, ...holes.flatMap((h) => [h.x, h.x + h.w])]);
  const ys = uniq([outer.y0, outer.y1, ...holes.flatMap((h) => [h.y, h.y + h.h])]);
  const nx = xs.length - 1, ny = ys.length - 1;
  const inHole = (cx, cy) => holes.some((h) => cx > h.x && cx < h.x + h.w && cy > h.y && cy < h.y + h.h);
  const solid = [];
  for (let i = 0; i < nx; i++) {
    solid.push([]);
    for (let j = 0; j < ny; j++) solid[i].push(!inHole((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2));
  }
  // 0 = outside the wall, 1 = solid, 2 = opening
  const kind = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : solid[i][j] ? 1 : 2);

  const quads = [[], [], []]; // per material group: { corners: 4 × [x, y, z], n: [x, y, z] }
  const push = (g, corners, n) => quads[g].push({ corners, n });
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!solid[i][j]) continue;
      const [xa, xb, ya, yb] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      push(WALL_GROUP.exterior, [[xa, ya, zExt], [xb, ya, zExt], [xb, yb, zExt], [xa, yb, zExt]], [0, 0, 1]);
      push(WALL_GROUP.interior, [[xa, ya, zInt], [xb, ya, zInt], [xb, yb, zInt], [xa, yb, zInt]], [0, 0, -1]);
      // Side faces: toward an opening (reveal) or past the wall boundary (edge, drawn like a reveal).
      const sides = [
        [kind(i - 1, j), [[xa, ya, zInt], [xa, ya, zExt], [xa, yb, zExt], [xa, yb, zInt]], [-1, 0, 0]],
        [kind(i + 1, j), [[xb, ya, zInt], [xb, ya, zExt], [xb, yb, zExt], [xb, yb, zInt]], [1, 0, 0]],
        [kind(i, j - 1), [[xa, ya, zInt], [xb, ya, zInt], [xb, ya, zExt], [xa, ya, zExt]], [0, -1, 0]],
        [kind(i, j + 1), [[xa, yb, zInt], [xb, yb, zInt], [xb, yb, zExt], [xa, yb, zExt]], [0, 1, 0]],
      ];
      for (const [k, corners, n] of sides) if (k !== 1) push(WALL_GROUP.reveal, corners, n);
    }
  }

  const count = quads.reduce((s, q) => s + q.length, 0) * 6;
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  const groups = [];
  let v = 0;
  quads.forEach((list, g) => {
    const start = v;
    for (const { corners, n } of list) {
      // Two triangles, wound counter-clockwise when seen from the side the normal points to.
      let tri = [0, 1, 2, 0, 2, 3];
      const [a, b, c] = corners;
      const cross = [
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
      ];
      if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0) tri = [0, 2, 1, 0, 3, 2];
      for (const t of tri) {
        const p = corners[t];
        position.set(p, v * 3);
        normal.set(n, v * 3);
        // Planar uv: faces use (x, y); reveals along x use (z, y); reveals along y use (x, z).
        uv.set(n[2] !== 0 ? [p[0], p[1]] : n[0] !== 0 ? [p[2], p[1]] : [p[0], p[2]], v * 2);
        v++;
      }
    }
    if (v > start) groups.push({ start, count: v - start, materialIndex: g });
  });
  return { position, normal, uv, groups };
}
