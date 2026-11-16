// Three.js wrapper around a GLB that carries `extras.cfg` userData (see schema.js).
// Holds the immutable reference geometry. Applies size, colours and animation scaling
// from that reference every time, so repeated edits never accumulate drift.
//
// VISUAL ONLY. Dimensions in this model come from the user's inputs plus the stored cfg
// factors. Nothing here may be read back as a manufacturing dimension, cut length or BOM value.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ROOT_SCHEMA, PART_SCHEMA, GROUP_SCHEMA, validateNodeCfg } from './schema.js';
import { deformPositions, collapseDelta, travelFactor } from './deform.js';
import { explodeDirection, EXPLODE_SCALE } from './explode.js';

export class ConfigError extends Error {
  constructor(errors) {
    super(`GLB configuration is invalid (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
    this.errors = errors;
  }
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 };

export async function loadGltf(source) {
  const loader = new GLTFLoader();
  if (source instanceof ArrayBuffer) return loader.parseAsync(source, '');
  return loader.loadAsync(source);
}

export class WindowModel {
  /** @param {{scene: THREE.Object3D, animations: THREE.AnimationClip[]}} gltf */
  constructor(gltf) {
    this.scene = gltf.scene;
    this.errors = [];
    this.parts = [];          // { name, object, cfg, meshes: [{mesh, ref:Float32Array}] }
    this.zoneMaterials = {};  // colorZone -> material (shared by all meshes of that zone)

    this.#collect();
    this.#bindAnimations(gltf.animations || []);
    if (!this.errors.length) this.limits = this.#computeLimits();
    if (this.errors.length) throw new ConfigError(this.errors);

    this.#bindMaterials();
    this.width_m = this.ref.width_m;
    this.height_m = this.ref.height_m;
    this.explode = 0;
    for (const p of this.parts) p.explodeDir = explodeDirection(p.cfg);
  }

  // ---------- setup ----------

  #collect() {
    let root = null;
    const meshesWithoutPart = [];

    this.scene.traverse((obj) => {
      const cfg = obj.userData?.cfg;
      if (cfg?.schema === ROOT_SCHEMA) {
        if (root) this.errors.push(`More than one root cfg (${root.name}, ${obj.name})`);
        root = obj;
      }
      if (cfg) this.errors.push(...validateNodeCfg(obj.name, cfg));
      if (obj.isMesh && !this.#owningPart(obj)) meshesWithoutPart.push(obj.name);
    });

    if (!root) { this.errors.push(`No node has extras.cfg.schema = "${ROOT_SCHEMA}"`); return; }
    this.root = root;
    this.rootCfg = root.userData.cfg;
    this.ref = this.rootCfg.reference;
    meshesWithoutPart.forEach((n) => this.errors.push(`${n}: mesh has no ${PART_SCHEMA} cfg on itself or a parent`));

    this.scene.traverse((obj) => {
      const cfg = obj.userData?.cfg;
      if (cfg?.schema !== PART_SCHEMA) return;
      const meshes = [];
      obj.traverse((m) => {
        if (!m.isMesh || this.#owningPart(m) !== obj) return;
        // Own the geometry. GLTFLoader may share accessors between primitives.
        m.geometry = m.geometry.clone();
        let pos = m.geometry.getAttribute('position');
        if (!pos || pos.itemSize !== 3 || pos.normalized || !(pos.array instanceof Float32Array)) {
          this.errors.push(`${obj.name}: POSITION must be a float32 vec3 attribute (quantized/normalized positions are not supported)`);
          return;
        }
        if (pos.isInterleavedBufferAttribute) {
          // Interleaved (byteStride) layouts are valid glTF, e.g. gltf-transform's default.
          // Copy positions into a private, tightly packed Float32Array. This is a value-for-value float copy
          // with no arithmetic, so reference positions are bit-identical to the file.
          const packed = new Float32Array(pos.count * 3);
          for (let i = 0; i < pos.count; i++) {
            packed[i * 3] = pos.getX(i);
            packed[i * 3 + 1] = pos.getY(i);
            packed[i * 3 + 2] = pos.getZ(i);
          }
          pos = new THREE.BufferAttribute(packed, 3);
          m.geometry.setAttribute('position', pos);
        }
        pos.setUsage(THREE.DynamicDrawUsage);
        meshes.push({ mesh: m, ref: pos.array.slice() });
      });
      this.parts.push({ name: obj.name, object: obj, cfg, meshes });
    });

    // Rigid-transform check: the deformation works in node-local space and assumes identity
    // transforms (geometry baked in reference coordinates). Fail loudly rather than mis-place parts.
    this.scene.traverse((obj) => {
      if (obj === this.scene) return;
      const isAnimatedGroup = obj.userData?.cfg?.schema === GROUP_SCHEMA;
      const t = obj.position, q = obj.quaternion, s = obj.scale;
      const identity = t.lengthSq() < 1e-14 && Math.abs(q.w) > 1 - 1e-9 && Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) < 1e-9;
      if (!identity && !isAnimatedGroup) this.errors.push(`${obj.name}: non-identity node transform is not supported`);
    });
  }

  #owningPart(obj) {
    for (let o = obj; o; o = o.parent) if (o.userData?.cfg?.schema === PART_SCHEMA) return o;
    return null;
  }

  #bindAnimations(clips) {
    this.mixer = new THREE.AnimationMixer(this.scene);
    this.clips = [];
    if (!this.rootCfg) return;
    for (const a of this.rootCfg.animations) {
      const clip = clips.find((c) => c.name === a.clip);
      if (!clip) { this.errors.push(`Animation clip "${a.clip}" listed in root cfg is not in the GLB`); continue; }
      const track = clip.tracks.find((t) => t.name.endsWith('.position'));
      if (!track) { this.errors.push(`Clip "${a.clip}" has no position track`); continue; }
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.clips.push({ cfg: a, clip, track, refValues: track.values.slice(), action, label: a.label || a.clip });
    }
  }

  #bindMaterials() {
    // Each colourable profile mesh gets one shared material per zone. The zone comes from the
    // material's own cfg (PVC_Exterior / PVC_Interior split, Part B) or else the node's cfg.colorZone.
    this.hasFaceSplit = false;
    for (const part of this.parts) {
      if (part.cfg.role !== 'profile') continue;
      for (const { mesh } of part.meshes) {
        const matZone = mesh.material.userData?.cfg?.colorZone;
        if (matZone) this.hasFaceSplit = true;
        const zone = matZone ?? part.cfg.colorZone;
        if (!this.zoneMaterials[zone]) this.zoneMaterials[zone] = mesh.material.clone();
        mesh.material = this.zoneMaterials[zone];
      }
    }
    // Initial colours come from the GLB (documented source), not from app defaults.
    this.initialColors = Object.fromEntries(
      Object.entries(this.zoneMaterials).map(([z, m]) => [z, `#${m.color.getHexString()}`]),
    );
  }

  #computeLimits() {
    let minDW = -Infinity, minDH = -Infinity;
    for (const p of this.parts) {
      // A stretchable axis needs vertices on both sides of its split (checked over all primitives).
      const all = p.meshes.length === 1 ? p.meshes[0].ref : Float32Array.from(p.meshes.flatMap((m) => Array.from(m.ref)));
      for (const [ax, comp] of [['x', 0], ['y', 1]]) {
        const a = p.cfg[ax];
        if (a.below === a.above) continue;
        const d = collapseDelta(all, a, comp);
        if (d === -Infinity) { this.errors.push(`${p.name}.${ax}: canScale is true but all vertices lie on one side of split_m ${a.split_m}`); continue; }
        if (ax === 'x') minDW = Math.max(minDW, d); else minDH = Math.max(minDH, d);
      }
    }
    // Geometric collapse limits only (the point where stretched parts would invert).
    // These are NOT product size limits.
    return { minWidth_m: this.ref.width_m + minDW, minHeight_m: this.ref.height_m + minDH };
  }

  // ---------- public API ----------

  setSize(width_m, height_m) {
    if (!(width_m > this.limits.minWidth_m) || !(height_m > this.limits.minHeight_m)) {
      throw new RangeError(`Size ${width_m} x ${height_m} m is below the geometric limit`);
    }
    const dW = width_m - this.ref.width_m;
    const dH = height_m - this.ref.height_m;
    const factors = this.clips.map((c) => travelFactor(c.cfg, dH));
    if (factors.some((f) => !(f > 0))) throw new RangeError(`Height ${height_m} m gives a non-positive sash travel`);
    for (const p of this.parts) {
      for (const { mesh, ref } of p.meshes) {
        const pos = mesh.geometry.getAttribute('position');
        deformPositions(ref, pos.array, p.cfg, dW, dH);
        pos.needsUpdate = true;
        mesh.geometry.computeBoundingBox();
        mesh.geometry.computeBoundingSphere();
      }
    }
    for (const [ci, c] of this.clips.entries()) {
      const f = factors[ci];
      const k = AXIS_INDEX[c.cfg.axis];
      const v = c.track.values;
      for (let i = k; i < v.length; i += 3) v[i] = c.refValues[i] * f; // in place: the interpolant reads this buffer
    }
    this.width_m = width_m;
    this.height_m = height_m;
    this.setExplode(this.explode); // explode distance scales with size
  }

  /**
   * Exploded view, t in [0, 1]. Moves part transforms only. Geometry and stored values are untouched,
   * and t = 0 restores the exact identity transforms.
   */
  setExplode(t) {
    this.explode = t;
    const D = EXPLODE_SCALE * Math.max(this.width_m, this.height_m) * t;
    for (const p of this.parts) {
      if (t === 0) p.object.position.set(0, 0, 0);
      else p.object.position.set(p.explodeDir[0] * D, p.explodeDir[1] * D, p.explodeDir[2] * D);
    }
  }

  /** Every material used by the window's meshes (for clipping planes / presentation tweaks). */
  materials() {
    const set = new Set();
    for (const p of this.parts) for (const { mesh } of p.meshes) set.add(mesh.material);
    return [...set];
  }

  /** Meshes grouped by what their section cap should look like. Each group's union is a set of closed solids. */
  capGroups() {
    const groups = { pvc: [], glass: [], gasket: [] };
    for (const p of this.parts) {
      const key = p.cfg.role === 'profile' ? 'pvc' : p.cfg.role;
      for (const { mesh } of p.meshes) groups[key]?.push(mesh);
    }
    return groups;
  }

  setZoneColor(zone, hex) {
    const m = this.zoneMaterials[zone];
    if (m) m.color.set(hex);
  }

  play(clipName, { loop = false, timeScale = 1 } = {}) {
    const targets = clipName ? this.clips.filter((c) => c.clip.name === clipName) : this.clips;
    for (const c of targets) {
      c.action.reset();
      c.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      c.action.timeScale = timeScale;
      c.action.play();
    }
  }

  setPaused(paused) { for (const c of this.clips) c.action.paused = paused; }
  setTimeScale(s) { for (const c of this.clips) c.action.timeScale = s; }

  /** Close both sashes (rest pose). */
  stop() { this.mixer.stopAllAction(); }

  update(dt) { this.mixer.update(dt); }

  /** True while any sash clip is advancing (the viewer renders continuously only then). */
  isAnimating() { return this.clips.some((c) => c.action.isRunning()); }

  getBounds() { return new THREE.Box3().setFromObject(this.root); }

  /** Rows for the parts inspector, straight from the stored cfg. */
  describeParts() {
    return this.parts.map((p) => ({
      name: p.name,
      role: p.cfg.role,
      assembly: p.cfg.assembly,
      side: p.cfg.side,
      canScaleX: p.cfg.canScaleX,
      canScaleY: p.cfg.canScaleY,
      colorZone: p.cfg.colorZone,
      primitives: p.meshes.length,
    }));
  }

  dispose() {
    this.mixer.stopAllAction();
    this.scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    Object.values(this.zoneMaterials).forEach((m) => m.dispose());
  }
}
