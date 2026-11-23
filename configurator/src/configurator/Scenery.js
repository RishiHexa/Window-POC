// Surroundings for the preview: a wall with the windows set in it, a room on the interior side and sky and ground on
// the exterior side. Browser only (textures are drawn on canvases).
//
// PRESENTATION ONLY. Nothing here is product, installation or building data, and nothing here feeds any dimension.
// The wall faces are placed from the windows' own geometry: the exterior face is flush with the frame's exterior
// face, and the interior face sits at the deepest extension edge, which is where an extension jamb meets the interior
// finish. Everything else (sill height, margins, room size, materials) is a labelled POC placeholder in SCENERY.

import * as THREE from 'three';
import { wallGeometry } from './wall.js';

const IN = 0.0254;

// ---- POC-only placeholders (NOT product or installation data) ------------------------------
export const SCENERY = {
  sillHeight_m: 30 * IN,      // interior floor to the lowest window's bottom
  wallSide_m: 3.0,            // wall beyond the windows, left and right
  aboveCeiling_m: 0.35,       // exterior wall above the ceiling line
  minCeiling_m: 2.44,         // 8 ft, raised if the windows reach higher
  headroom_m: 0.3,            // ceiling above the highest window, when that is more than minCeiling
  roomSide_m: 1.5,            // room wider than the windows on each side
  roomDepth_m: 4.5,
  // Ceiling light (candela, decay 2), so the interior is not ambient-only. Dimmer than before (was 7) so the room
  // seen through the glass reads a little darker than the frames, as a real interior does from outside.
  roomLight: { intensity: 5, color: '#fff3e2' },
  colors: {
    plaster: '#efece6', paint: '#e8e2d8', ceiling: '#f5f4f1', ground: '#8e9a74',
    skyTop: '#7ea7d1', skyHorizon: '#dde7ef',
  },
};
// ---------------------------------------------------------------------------------------------

function canvasTexture(w, h, draw, tile_m) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (tile_m) t.repeat.set(1 / tile_m[0], 1 / tile_m[1]); // uv is in metres
  t.anisotropy = 8;
  return t;
}

// Deterministic pseudo-random, so the pattern is identical on every load.
const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** Running-bond brick: 8 in × 2 2/3 in modules (brick plus mortar), 4 × 12 per tile. */
function brickTexture() {
  const tile = [4 * 8 * IN, 12 * (8 / 3) * IN];
  const palette = ['#9a5a45', '#8e5240', '#a3644c', '#86503f', '#9f5d47', '#925845', '#a86a51'];
  const r = rng(7);
  return canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = '#c9c2b6'; // mortar
    g.fillRect(0, 0, w, h);
    const bw = w / 4, bh = h / 12, m = 3;
    for (let row = 0; row < 12; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let k = -1; k < 5; k++) {
        g.fillStyle = palette[Math.floor(r() * palette.length)];
        g.fillRect(k * bw + off + m / 2, h - (row + 1) * bh + m / 2, bw - m, bh - m);
      }
    }
  }, tile);
}

/** Floor boards along x: 5.5 in wide, staggered end joints. */
function woodTexture() {
  const tile = [48 * IN, 8 * 5.5 * IN];
  const tones = ['#b08a62', '#a98259', '#b8936a', '#a07a52', '#b48d63'];
  const r = rng(11);
  return canvasTexture(512, 512, (g, w, h) => {
    const bh = h / 8;
    for (let row = 0; row < 8; row++) {
      let x = -Math.floor(r() * w * 0.6);
      while (x < w) {
        const len = w * (0.35 + r() * 0.5);
        g.fillStyle = tones[Math.floor(r() * tones.length)];
        g.fillRect(x, row * bh, len - 2, bh - 2);
        x += len;
      }
    }
  }, tile);
}

/**
 * Sky as a gradient dome mesh rather than a scene.background texture. The AO pass renders the scene (background
 * included) into its own normal buffer, and a texture background there turned the whole AO clip box black. A mesh on
 * the scenery layer stays out of that pass. Drawn first, without depth, so everything else draws over it.
 */
function skyDome(radius) {
  const geo = new THREE.SphereGeometry(radius, 32, 16);
  const top = new THREE.Color(SCENERY.colors.skyTop), horizon = new THREE.Color(SCENERY.colors.skyHorizon);
  const pos = geo.getAttribute('position'), col = new Float32Array(pos.count * 3), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(Math.max(0, pos.getY(i) / radius), 0.6);
    c.copy(horizon).lerp(top, t).toArray(col, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
  m.name = 'Sky';
  m.renderOrder = -1;
  return m;
}
const SKY_RADIUS_M = 20; // inside the camera's far plane (30 m) from any normal orbit position

const std = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...opts });

export class Scenery {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'Scenery';
    this.sky = skyDome(SKY_RADIUS_M);
    this.horizon = new THREE.Color(SCENERY.colors.skyHorizon); // clear colour behind the dome
    this.mat = {
      brick: std({ map: brickTexture(), roughness: 0.95 }),
      paint: std({ color: SCENERY.colors.paint }),
      plaster: std({ color: SCENERY.colors.plaster }),
      ceiling: std({ color: SCENERY.colors.ceiling }),
      floor: std({ map: woodTexture(), roughness: 0.7 }),
      ground: std({ color: SCENERY.colors.ground, roughness: 1 }),
    };
    this.wall = new THREE.Mesh(new THREE.BufferGeometry(), [this.mat.brick, this.mat.paint, this.mat.plaster]);
    this.wall.name = 'Wall';
    this.wall.castShadow = this.wall.receiveShadow = true;
    const plane = (mat, name) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.name = name;
      m.receiveShadow = true;
      return m;
    };
    this.room = {
      floor: plane(this.mat.floor, 'RoomFloor'),
      ceiling: plane(this.mat.ceiling, 'RoomCeiling'),
      back: plane(this.mat.paint, 'RoomBack'),
      left: plane(this.mat.paint, 'RoomLeft'),
      right: plane(this.mat.paint, 'RoomRight'),
    };
    this.ground = plane(this.mat.ground, 'ExteriorGround');
    this.light = new THREE.PointLight(SCENERY.roomLight.color, SCENERY.roomLight.intensity, 0, 2); // no shadows
    this.light.name = 'RoomLight';
    this.group.add(this.sky, this.wall, this.ground, this.light, ...Object.values(this.room));
    this.key = '';
    this.bounds = new THREE.Box3();
  }

  /**
   * Rebuild around the windows. `rects` are frame outside rectangles in metres (assembled, not exploded) and
   * `depth` is { min, max } from WindowAssembly.restDepth_m(). Cheap to call often: it only rebuilds on change.
   */
  update(rects, depth) {
    const key = JSON.stringify([rects, depth]);
    if (key === this.key) return false;
    this.key = key;
    const S = SCENERY;
    const minX = Math.min(...rects.map((r) => r.x)), maxX = Math.max(...rects.map((r) => r.x + r.w));
    const minY = Math.min(...rects.map((r) => r.y)), maxY = Math.max(...rects.map((r) => r.y + r.h));
    const zExt = depth.max, zInt = depth.min;
    const floorY = minY - S.sillHeight_m;
    const ceilY = Math.max(floorY + S.minCeiling_m, maxY + S.headroom_m);
    const outer = { x0: minX - S.wallSide_m, x1: maxX + S.wallSide_m, y0: floorY, y1: ceilY + S.aboveCeiling_m };

    const g = wallGeometry(rects, outer, zInt, zExt);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
    for (const gr of g.groups) geo.addGroup(gr.start, gr.count, gr.materialIndex);
    this.wall.geometry.dispose();
    this.wall.geometry = geo;

    // Room on the interior side (−z). Its planes face inward and there is no plane on the wall side, so the room is
    // seen through the windows from outside, and from a camera behind the back wall it reads as a cut-away.
    const rx0 = minX - S.roomSide_m, rx1 = maxX + S.roomSide_m, rz0 = zInt - S.roomDepth_m;
    const W = rx1 - rx0, H = ceilY - floorY, D = zInt - rz0, cx = (rx0 + rx1) / 2, cy = (floorY + ceilY) / 2, cz = (zInt + rz0) / 2;
    const place = (m, sx, sy, pos, rot) => { m.scale.set(sx, sy, 1); m.position.set(...pos); m.rotation.set(...rot); };
    place(this.room.floor, W, D, [cx, floorY, cz], [-Math.PI / 2, 0, 0]);
    place(this.room.ceiling, W, D, [cx, ceilY, cz], [Math.PI / 2, 0, 0]);
    place(this.room.back, W, H, [cx, cy, rz0], [0, 0, 0]);
    place(this.room.left, D, H, [rx0, cy, cz], [0, Math.PI / 2, 0]);
    place(this.room.right, D, H, [rx1, cy, cz], [0, -Math.PI / 2, 0]);
    this.light.position.set(cx, ceilY - 0.4, zInt - Math.min(2, S.roomDepth_m / 2));
    // The floor texture tiles in metres: scale its uvs by the plane size.
    this.room.floor.geometry.dispose();
    this.room.floor.geometry = new THREE.PlaneGeometry(1, 1);
    const uv = this.room.floor.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * W, uv.getY(i) * D);

    // Exterior ground, in front of the wall.
    const GR = 20;
    place(this.ground, (outer.x1 - outer.x0) + 2 * GR, GR, [(outer.x0 + outer.x1) / 2, floorY, zExt + GR / 2], [-Math.PI / 2, 0, 0]);

    this.sky.position.set((outer.x0 + outer.x1) / 2, floorY, (zInt + zExt) / 2);
    this.floorY = floorY;
    this.bounds.set(new THREE.Vector3(outer.x0, floorY, rz0), new THREE.Vector3(outer.x1, outer.y1, zExt));
    return true;
  }

  dispose() {
    this.wall.geometry.dispose();
    for (const m of [...Object.values(this.room), this.ground]) m.geometry.dispose();
    for (const m of Object.values(this.mat)) { m.map?.dispose(); m.dispose(); }
    this.sky.geometry.dispose();
    this.sky.material.dispose();
  }
}
