// Several independent windows shown together. Each window is its own WindowModel, built from its own parse of its
// GLB, so geometry, materials and animation clips are never shared between windows. Each window has its own type,
// size, colours and animation. Placement comes from assembly.js (pure layout, inches).
//
// VISUAL ONLY. The joint between windows (mullion / coupler / mull cover) is NOT modelled: there is no documented
// data for it, so nothing is invented. Windows are butted frame to frame.
//
// Depth alignment: windows of different types have different frame depths (Window_V3 3.979 in, Casement_V4
// 3.250 in). They are lined up on the interior (back) edge of their jamb extension, where the extension meets the
// interior wall finish, not on the frame or sash front. The window(s) with the deepest extension stay at z = 0 and
// the others move toward the interior, so the front faces step where frame depths differ. The extension is found from
// the GLB's own cfg (parts with cfg.assembly "Extension"); a window type without one cannot be aligned and is refused. Overall sizes are only the extents of the
// frame outside sizes and are not order, mulling or manufacturing dimensions. Each window still deforms only through
// WindowModel (split-plane stretch).
//
// It exposes what WindowViewer needs (scene, isAnimating, update, setExplode, getBounds, materials, capGroups,
// models), the same names WindowModel uses for a single window.

import * as THREE from 'three';
import { inToM } from './deform.js';
import { placeAll, extents, checkAdd, checkResize, checkRemove, removeFrom } from './assembly.js';

/** cfg.assembly of the jamb extension parts. Their most interior face is the depth alignment plane. */
export const JAMB_EXTENSION_ASSEMBLY = 'Extension';

/**
 * Interior (back) edge of a model's jamb extension, in model space (m): the minimum z of the extension parts'
 * reference positions, which are the GLB's own values (resizing never moves z, see deform.js). Throws if the model
 * has no extension, so an unalignable window is never placed at a guessed depth.
 */
export function jambBack_m(model) {
  let min = Infinity;
  for (const p of model.parts) {
    if (p.cfg.assembly !== JAMB_EXTENSION_ASSEMBLY) continue;
    for (const { ref } of p.meshes) for (let i = 2; i < ref.length; i += 3) if (ref[i] < min) min = ref[i];
  }
  if (!Number.isFinite(min)) throw new RangeError(`This window type has no jamb extension (cfg.assembly "${JAMB_EXTENSION_ASSEMBLY}"), so its depth cannot be aligned with the other windows`);
  return min;
}

// How far exploded windows move apart, as a fraction of their centre's distance from the assembly centre, so that
// each window's own exploded parts don't run into its neighbours'. Presentation only.
export const EXPLODE_SPREAD = 0.6;

export class WindowAssembly {
  constructor() {
    this.scene = new THREE.Group();
    this.scene.name = 'WindowAssembly';
    /** @type {{id:number, parent:number|null, side:string|null, w:number, h:number, model:any, holder:THREE.Group, type:{key:string,label:string}, colors:Record<string,string>}[]} */
    this.units = [];
    this.explode = 0;
    this.nextId = 1;
  }

  // ---------- read ----------

  get(id) { return this.units.find((u) => u.id === id) ?? null; }
  get models() { return this.units.map((u) => u.model); }
  /** The layout rows assembly.js works on (inches). */
  layout() { return this.units.map(({ id, parent, side, w, h }) => ({ id, parent, side, w, h })); }
  /** Map id → { x, y, w, h } in inches (assembled positions, explode not included). */
  rects() { return placeAll(this.layout()); }
  extents() { return extents(this.rects()); }

  checkAdd(parentId, side, w, h) { return checkAdd(this.layout(), parentId, side, w, h); }
  checkResize(id, w, h) { return checkResize(this.layout(), id, w, h); }
  checkRemove(id) { return checkRemove(this.layout(), id); }

  // ---------- structure ----------

  /**
   * Add a window. The first window needs no parent. Every later window goes on `side` of `parent`.
   * The model is sized to w × h (inches) and coloured before it is shown. On any error nothing is added, and the
   * caller still owns (and should dispose) the model.
   * @returns {number} the new window's id
   */
  add(model, { parent = null, side = null, w, h, type, colors }) {
    if (this.units.length === 0) {
      if (parent != null) throw new RangeError('The first window has no parent');
    } else {
      const c = this.checkAdd(parent, side, w, h);
      if (!c.ok) throw new RangeError(c.reason);
    }
    const jambBack = jambBack_m(model); // throws before changing anything if the type has no extension
    model.setSize(inToM(w), inToM(h)); // throws RangeError below the model's geometric limit, before changing anything
    const id = this.nextId++;
    const holder = new THREE.Group();
    holder.name = `Window_${id}`;
    holder.userData.windowId = id;
    holder.add(model.scene);
    const unit = { id, parent: this.units.length ? parent : null, side: this.units.length ? side : null, w, h, model, holder, type, colors: { ...colors }, jambBack };
    this.#applyColors(unit);
    this.units.push(unit);
    this.scene.add(holder);
    model.setExplode(this.explode);
    this.#place();
    return id;
  }

  /** Remove a window (see assembly.js checkRemove for when that is allowed). Its model is disposed. */
  remove(id) {
    const next = removeFrom(this.layout(), id); // throws if not allowed
    const u = this.get(id);
    this.scene.remove(u.holder);
    u.model.dispose();
    this.units = this.units.filter((x) => x.id !== id);
    for (const row of next) Object.assign(this.get(row.id), { parent: row.parent, side: row.side });
    this.#place();
  }

  /** Resize one window (inches). Windows attached to it move with it. Blocked if anything would overlap. */
  setSize(id, w, h) {
    const u = this.#unit(id);
    const c = this.checkResize(id, w, h);
    if (!c.ok) throw new RangeError(c.reason);
    u.model.setSize(inToM(w), inToM(h)); // throws before changing anything if below the geometric limit
    u.w = w; u.h = h;
    this.#place();
  }

  /**
   * Swap a window's type (a different GLB). The window keeps its place, size and colours. If the new model cannot
   * take that size, this throws and the old model stays; the caller still owns the new one.
   */
  replaceModel(id, model, type) {
    const u = this.#unit(id);
    const jambBack = jambBack_m(model);
    model.setSize(inToM(u.w), inToM(u.h));
    u.model.stop();
    u.holder.remove(u.model.scene);
    u.model.dispose();
    u.model = model;
    u.type = type;
    u.jambBack = jambBack;
    u.holder.add(model.scene);
    this.#applyColors(u);
    model.setExplode(this.explode);
    this.#place(); // a different frame depth can move this window, or all others, in z
  }

  setColor(id, zone, hex) {
    const u = this.#unit(id);
    u.colors[zone] = hex;
    u.model.setZoneColor(zone, hex);
  }

  // ---------- presentation ----------

  /** Exploded view, t in [0, 1]. Each window explodes its own parts, and windows move apart from the centre. */
  setExplode(t) {
    this.explode = t;
    for (const u of this.units) u.model.setExplode(t);
    this.#place();
  }

  /** Window rectangle in metres, in world space (follows the explode spread). */
  worldRect(id) {
    const u = this.#unit(id);
    const p = u.holder.position;
    return { x: p.x, y: p.y, w: inToM(u.w), h: inToM(u.h) };
  }

  /** World z offset of window `id` from the depth alignment (m, <= 0). Explode does not change it. */
  depthOffset_m(id) { return this.#depthOffset(this.#unit(id)); }

  /**
   * Depth range of all windows at rest, in metres: { min, max } along z (+z is the exterior), including each window's
   * depth alignment offset. Read from the parts' deformed geometry, which explode and sash animation never change
   * (they move nodes, not vertices). For the bundled GLBs, min is the shared extension interior edge and max is the
   * exterior face of the deepest frame. Presentation only.
   */
  restDepth_m() {
    let min = Infinity, max = -Infinity;
    for (const u of this.units) {
      const dz = this.#depthOffset(u);
      for (const p of u.model.parts) {
        for (const { mesh } of p.meshes) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          min = Math.min(min, mesh.geometry.boundingBox.min.z + dz);
          max = Math.max(max, mesh.geometry.boundingBox.max.z + dz);
        }
      }
    }
    return { min, max };
  }

  isAnimating() { return this.units.some((u) => u.model.isAnimating()); }
  update(dt) { for (const u of this.units) if (u.model.isAnimating()) u.model.update(dt); }
  stop() { for (const u of this.units) u.model.stop(); }
  setPaused(paused) { for (const u of this.units) u.model.setPaused(paused); }
  setTimeScale(s) { for (const u of this.units) u.model.setTimeScale(s); }

  materials() { return [...new Set(this.units.flatMap((u) => u.model.materials()))]; }

  capGroups() {
    const groups = { pvc: [], glass: [], gasket: [], hardware: [] };
    for (const u of this.units) for (const [k, list] of Object.entries(u.model.capGroups())) groups[k]?.push(...list);
    return groups;
  }

  getBounds() {
    this.scene.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.scene);
  }

  dispose() {
    for (const u of this.units) u.model.dispose();
    this.units = [];
    this.scene.clear();
  }

  // ---------- internal ----------

  #unit(id) {
    const u = this.get(id);
    if (!u) throw new RangeError(`Window ${id} does not exist`);
    return u;
  }

  #applyColors(u) {
    for (const [zone, hex] of Object.entries(u.colors)) u.model.setZoneColor(zone, hex);
  }

  /** Shared alignment plane: the deepest jamb extension back edge among all windows (m). */
  #jambPlane() { return Math.min(...this.units.map((u) => u.jambBack)); }

  /** z shift that puts this window's extension back edge on the shared plane (0 for the deepest window). */
  #depthOffset(u) { return this.#jambPlane() - u.jambBack; }

  /** Holder positions from the layout (inches → metres), plus the explode spread. explode 0 gives the exact layout. */
  #place() {
    if (!this.units.length) return;
    const rects = this.rects();
    const e = extents(rects);
    const cx = (e.minX + e.maxX) / 2, cy = (e.minY + e.maxY) / 2;
    const k = EXPLODE_SPREAD * this.explode;
    const plane = this.#jambPlane();
    for (const u of this.units) {
      const r = rects.get(u.id);
      let x = r.x, y = r.y;
      if (k) { x += (r.x + r.w / 2 - cx) * k; y += (r.y + r.h / 2 - cy) * k; }
      u.holder.position.set(inToM(x), inToM(y), plane - u.jambBack);
    }
  }
}
