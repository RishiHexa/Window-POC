// Three.js wrapper around a GLB that carries `extras.cfg` userData (see schema.js).
// Holds the immutable reference geometry. Applies size, colours and animation scaling
// from that reference every time, so repeated edits never accumulate drift.
//
// VISUAL ONLY. Dimensions in this model come from the user's inputs plus the stored cfg
// factors. Nothing here may be read back as a manufacturing dimension, cut length or BOM value.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  ROOT_SCHEMA, PART_SCHEMA, GROUP_SCHEMA, HINGE_SCHEMA, HINGE_PIVOT_ROLES, HINGE_OFFSET_ROLES,
  validateNodeCfg, animationMotion, animationDirection,
} from './schema.js';
import { deformPositions, collapseDelta, travelFactor, rigidFitDelta } from './deform.js';
import { explodeDirection, EXPLODE_SCALE } from './explode.js';

export class ConfigError extends Error {
  constructor(errors) {
    super(`GLB configuration is invalid (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
    this.errors = errors;
  }
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 };
// three.js stores node names sanitized (e.g. "Hinge_Top_SashArm_14.97" -> "Hinge_Top_SashArm_1497").
const nodeKey = (name) => THREE.PropertyBinding.sanitizeNodeName(name);

/** True if clip b is clip a played backwards: same tracks, symmetric key times, values reversed exactly. */
function isExactReverse(a, b) {
  if (a.tracks.length !== b.tracks.length) return false;
  return a.tracks.every((ta) => {
    const tb = b.tracks.find((t) => t.name === ta.name);
    if (!tb || tb.times.length !== ta.times.length || tb.values.length !== ta.values.length) return false;
    const n = ta.times.length, w = ta.values.length / n, T = ta.times;
    for (let i = 0; i < n; i++) {
      if (tb.times[i] !== T[i] || Math.abs(T[i] - (T[0] + T[n - 1] - T[n - 1 - i])) > 1e-6) return false;
      for (let j = 0; j < w; j++) if (tb.values[i * w + j] !== ta.values[(n - 1 - i) * w + j]) return false;
    }
    return true;
  });
}

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
    this.hinges = [];
    if (this.root) this.#collectHinges();
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
    // Hinge pivot/offset pairs are exempt here; #collectHinges checks that each pair cancels exactly.
    this.scene.traverse((obj) => {
      if (obj === this.scene) return;
      const schema = obj.userData?.cfg?.schema;
      const isAnimatedGroup = schema === GROUP_SCHEMA || schema === HINGE_SCHEMA;
      const t = obj.position, q = obj.quaternion, s = obj.scale;
      const identity = t.lengthSq() < 1e-14 && Math.abs(q.w) > 1 - 1e-9 && Math.abs(s.x - 1) + Math.abs(s.y - 1) + Math.abs(s.z - 1) < 1e-9;
      if (!identity && !isAnimatedGroup) this.errors.push(`${obj.name}: non-identity node transform is not supported`);
    });
  }

  /**
   * Hinge pivot/offset pairs (davinci.window.hinge/1, Casement GLBs). At rest the pivot holds P and its
   * child offset holds -P, so the meshes below keep absolute reference coordinates. Anything that would
   * break that (wrong parent, P not matching the stored pivot_m, rest rotation/scale) is an error.
   */
  #collectHinges() {
    const isIdentityRS = (o) => Math.abs(o.quaternion.w) > 1 - 1e-12
      && Math.abs(o.scale.x - 1) + Math.abs(o.scale.y - 1) + Math.abs(o.scale.z - 1) < 1e-12;
    const pairedOffsets = new Set();
    this.scene.traverse((pivot) => {
      const cfg = pivot.userData?.cfg;
      if (cfg?.schema !== HINGE_SCHEMA || !HINGE_PIVOT_ROLES.includes(cfg.role)) return;
      if (!Array.isArray(cfg.pivot_m) || typeof cfg.offsetNode !== 'string') return; // already reported by schema.js
      const n = pivot.name;
      const offset = this.scene.getObjectByName(nodeKey(cfg.offsetNode));
      if (!offset) { this.errors.push(`${n}: offsetNode "${cfg.offsetNode}" not found`); return; }
      const ocfg = offset.userData?.cfg;
      if (offset.parent !== pivot) this.errors.push(`${n}: offset node ${offset.name} must be its direct child`);
      if (ocfg?.schema !== HINGE_SCHEMA || !HINGE_OFFSET_ROLES.includes(ocfg.role) || nodeKey(String(ocfg.pivotNode)) !== n) {
        this.errors.push(`${offset.name}: must be a hinge offset whose pivotNode is ${n}`);
      }
      const P = new THREE.Vector3().fromArray(cfg.pivot_m);
      if (pivot.position.distanceTo(P) > 1e-9) this.errors.push(`${n}: node translation does not match cfg.pivot_m`);
      if (pivot.position.clone().add(offset.position).lengthSq() !== 0) {
        this.errors.push(`${n}: pivot + offset translation must be exactly [0, 0, 0]`);
      }
      if (!isIdentityRS(pivot) || !isIdentityRS(offset)) this.errors.push(`${n}: hinge nodes must have identity rotation and scale at rest`);
      pairedOffsets.add(offset);
      this.hinges.push({ name: n, pivot, offset, cfg, P });
    });
    this.scene.traverse((o) => {
      const cfg = o.userData?.cfg;
      if (cfg?.schema === HINGE_SCHEMA && HINGE_OFFSET_ROLES.includes(cfg.role) && !pairedOffsets.has(o)) {
        this.errors.push(`${o.name}: hinge offset has no pivot that names it`);
      }
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
      const motion = animationMotion(a);
      let entry;
      if (motion === 'translate') {
        const track = clip.tracks.find((t) => t.name.endsWith('.position'));
        if (!track) { this.errors.push(`Clip "${a.clip}" has no position track`); continue; }
        entry = { track, refValues: track.values.slice() };
      } else {
        entry = this.#bindHingeClip(a, clip, motion);
        if (!entry) continue;
      }
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.clips.push({ cfg: a, clip, motion, direction: animationDirection(a), ...entry, action, label: a.label || a.clip });
    }
    for (const h of this.hinges) {
      for (const name of [h.cfg.clip, h.cfg.closeClip].filter((n) => n !== undefined)) {
        if (!this.rootCfg.animations.some((a) => a.clip === name)) this.errors.push(`${h.name}: clip "${name}" is not listed in the root cfg animations`);
      }
    }
    this.#pairOpenClose();
  }

  /**
   * Open/close pairs (Casement_V4+): the close clip is named by the hinge pivot's cfg.closeClip and its open
   * counterpart by that pivot's cfg.clip. The two drive the same nodes, so playing one stops the other.
   * `mirrored` is true only if the close clip is verified to be the open clip's exact time-reverse
   * (same tracks, symmetric key times, reversed values). Only then can a switch continue from the mirrored
   * time without a jump; otherwise the new clip simply starts from its beginning.
   */
  #pairOpenClose() {
    for (const c of this.clips) {
      if (c.direction !== 'close') continue;
      const h = this.hinges.find((x) => x.cfg.role === 'hingePivot' && x.cfg.closeClip === c.clip.name && x.name === nodeKey(String(c.cfg.node)));
      const open = h && this.clips.find((o) => o.clip.name === h.cfg.clip && o.direction === 'open');
      if (!open) { this.errors.push(`Clip "${c.clip.name}" (direction close): no hinge pivot names it as closeClip next to an open clip`); continue; }
      c.counterpart = open;
      open.counterpart = c;
      c.mirrored = open.mirrored = isExactReverse(open.clip, c.clip);
    }
  }

  /**
   * Rotate / rotate+slide clips (casement). Every track must drive a hinge pivot of this clip (or, for a close
   * clip, a pivot driven by its open counterpart). Rotation keys are used as stored (the angle does not depend
   * on size). Position keys hold the absolute pivot path at the reference size; setSize shifts them by
   * (dW * pivotFactor.x, dH * pivotFactor.y, 0) and never scales them, because the hardware slide is fixed.
   * The rest pivot is the first key of an open clip and the last key of a close clip.
   */
  #bindHingeClip(a, clip, motion) {
    const errs = [];
    const posTracks = [];
    const driven = new Set();
    const close = animationDirection(a) === 'close';
    const owner = close ? this.hinges.find((h) => h.cfg.closeClip === a.clip) : null;
    const drives = (h) => h.cfg.clip === a.clip || h.cfg.closeClip === a.clip || (owner && h.cfg.clip === owner.cfg.clip);
    for (const track of clip.tracks) {
      const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
      const hinge = this.hinges.find((h) => h.name === nodeName);
      if (!hinge || !drives(hinge)) { errs.push(`Clip "${a.clip}": track ${track.name} does not drive a hinge pivot of this clip`); continue; }
      driven.add(`${nodeName}.${propertyName}`);
      if (propertyName === 'quaternion') continue;
      if (propertyName !== 'position') { errs.push(`Clip "${a.clip}": ${propertyName} tracks are not supported on hinges`); continue; }
      const v = track.values;
      const k = close ? v.length - 3 : 0;
      if (Math.hypot(v[k] - hinge.P.x, v[k + 1] - hinge.P.y, v[k + 2] - hinge.P.z) > 1e-6) {
        errs.push(`Clip "${a.clip}": ${close ? 'last' : 'first'} ${track.name} key must equal the hinge rest pivot (absolute keys expected)`);
      }
      posTracks.push({ track, refValues: v.slice(), hinge });
    }
    const node = nodeKey(String(a.node));
    if (!this.hinges.some((h) => h.name === node)) errs.push(`Clip "${a.clip}": animation node "${a.node}" is not a hinge pivot`);
    if (!driven.has(`${node}.quaternion`)) errs.push(`Clip "${a.clip}" has no rotation track on ${a.node}`);
    if (motion === 'rotate+slide' && !driven.has(`${node}.position`)) errs.push(`Clip "${a.clip}" has no translation track on ${a.node}`);
    this.errors.push(...errs);
    return errs.length ? null : { posTracks };
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
    // Rigid hardware (fixed-size hinge parts) should stay inside the frame outside edges. This is reported,
    // not enforced: it only says where the preview's fixed-size hardware would poke out of the frame.
    let fitDW = -Infinity, fitDH = -Infinity;
    for (const p of this.parts) {
      if (p.cfg.role !== 'hardware') continue;
      const b = new THREE.Box3();
      for (const { ref } of p.meshes) b.union(new THREE.Box3().setFromArray(ref));
      fitDW = Math.max(fitDW, rigidFitDelta(b.min.x, b.max.x, p.cfg.x.below, this.ref.width_m));
      fitDH = Math.max(fitDH, rigidFitDelta(b.min.y, b.max.y, p.cfg.y.below, this.ref.height_m));
    }
    // Geometric collapse limits only (the point where stretched parts would invert).
    // These are NOT product size limits.
    return {
      minWidth_m: this.ref.width_m + minDW,
      minHeight_m: this.ref.height_m + minDH,
      hardwareFitWidth_m: Number.isFinite(fitDW) ? this.ref.width_m + fitDW : null,
      hardwareFitHeight_m: Number.isFinite(fitDH) ? this.ref.height_m + fitDH : null,
    };
  }

  // ---------- public API ----------

  setSize(width_m, height_m) {
    if (!(width_m > this.limits.minWidth_m) || !(height_m > this.limits.minHeight_m)) {
      throw new RangeError(`Size ${width_m} x ${height_m} m is below the geometric limit`);
    }
    const dW = width_m - this.ref.width_m;
    const dH = height_m - this.ref.height_m;
    const factors = this.clips.map((c) => (c.motion === 'translate' ? travelFactor(c.cfg, dH) : 1));
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
      if (c.motion !== 'translate') continue;
      const f = factors[ci];
      const k = AXIS_INDEX[c.cfg.axis];
      const v = c.track.values;
      for (let i = k; i < v.length; i += 3) v[i] = c.refValues[i] * f; // in place: the interpolant reads this buffer
    }
    if (this.hinges.length) this.#placeHinges(dW, dH);
    this.width_m = width_m;
    this.height_m = height_m;
    this.setExplode(this.explode); // explode distance scales with size
  }

  /**
   * Hinge pivots follow their side: P' = P + (dW * pivotFactor.x, dH * pivotFactor.y, 0), offset = -P'.
   * Clip position keys get the same shift. Recomputed from the stored reference values every time.
   *
   * The mixer saves each animated node's rest transform when its action starts, and restores it on stop.
   * Rest pivots change here, so hinge actions that are playing or held open are stopped first and resumed
   * at the same time afterwards. "Close" after a resize then returns to the new rest pose, not the old one.
   */
  #placeHinges(dW, dH) {
    const resume = this.clips
      .filter((c) => c.motion !== 'translate' && c.action.isScheduled())
      .map((c) => ({ action: c.action, time: c.action.time, paused: c.action.paused, enabled: c.action.enabled }));
    resume.forEach((r) => r.action.stop());
    for (const h of this.hinges) {
      const f = h.cfg.pivotFactor;
      h.pivot.position.set(h.P.x + dW * f.x, h.P.y + dH * f.y, h.P.z);
      h.offset.position.copy(h.pivot.position).negate();
    }
    for (const c of this.clips) {
      for (const { track, refValues, hinge } of c.posTracks ?? []) {
        const dx = dW * hinge.cfg.pivotFactor.x, dy = dH * hinge.cfg.pivotFactor.y;
        const v = track.values; // in place: the interpolant reads this buffer
        for (let i = 0; i < v.length; i += 3) { v[i] = refValues[i] + dx; v[i + 1] = refValues[i + 1] + dy; v[i + 2] = refValues[i + 2]; }
      }
    }
    for (const r of resume) {
      r.action.play();
      r.action.time = r.time;
      r.action.paused = r.paused;
      r.action.enabled = r.enabled;
    }
    if (resume.length) this.mixer.update(0); // re-apply the current pose (a held-open action is not advancing)
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
    const groups = { pvc: [], glass: [], gasket: [], hardware: [] };
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
    // No name = every opening clip (both sashes of a double-hung). Close clips are only played by name.
    const targets = clipName ? this.clips.filter((c) => c.clip.name === clipName) : this.clips.filter((c) => c.direction !== 'close');
    for (const c of targets) {
      // Open and close drive the same nodes. Stop the other one first; the mixer then restores the rest
      // pose, and this action saves that same rest pose when it starts.
      let start = 0;
      const other = c.counterpart;
      if (other) {
        if (other.action.isScheduled()) {
          if (c.mirrored) start = Math.min(c.clip.duration, Math.max(0, other.clip.duration - other.action.time));
        } else if (c.direction === 'close') {
          start = c.clip.duration; // already at rest: closing is a no-op (hold the closed end pose)
        }
        other.action.stop();
      }
      c.action.reset();
      c.action.time = start;
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
