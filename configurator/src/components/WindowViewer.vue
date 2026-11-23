<script setup>
// Pure renderer. It owns the three.js scene, camera, post-processing, section planes and the explode
// easing, and draws whatever WindowAssembly it is given. It never feeds anything back into the model's
// dimensions. Everything here is presentation.
//
// Grid controls (multi-window): a + chip on each free side of each window asks the parent to add a window
// there, a label chip in each window selects it, and an outline marks the selected window. The chips are DOM
// elements anchored to the windows (CSS2DRenderer). They only emit events; the parent owns the layout.
//
// Performance (target 60 fps):
//  - Render on demand: frames are drawn only while something changes (orbit/damping, sash animation,
//    explode easing, or a prop/model change via invalidate()). An idle viewer costs no GPU.
//  - The shadow map is redrawn only when geometry or transforms change, not when the camera moves.
//  - Glass uses the GLB's own alpha-blended material, so there is no transmission pass.
//  - FrameGovernor steps pixel ratio, MSAA and AO down if rendered frames miss the budget.
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { SectionCaps, LAYER_HELPERS } from '../configurator/SectionCaps.js';
import { FrameGovernor, QUALITY_LEVELS } from '../configurator/FrameGovernor.js';
import { Scenery } from '../configurator/Scenery.js';
import { inToM } from '../configurator/deform.js';
import { applySurfaceDetail, surfaceDetailUniforms } from '../configurator/surfaceDetail.js';

const LAYER_GLASS = 3; // rendered, but kept out of the AO normal pass
// Wall, room and sky: rendered and shadowed on their own layer. The AO camera includes this layer so the wall hides
// what is behind it: without it, AO computed on window parts behind the wall (extension heads, an open casement arm)
// was blended onto the wall pixels in front of them and showed through as ghost outlines. The room seen through the
// glass lies outside the AO clip box (model bounds + 0.3 m, see fitStage), so it gets no AO and does not go black.
const LAYER_SCENERY = 4;

const props = defineProps({
  assembly: { type: Object, default: null },       // WindowAssembly (markRaw'd by the parent)
  version: { type: Number, default: 0 },            // bumped by the parent when windows are added, removed or replaced
  selected: { type: Number, default: null },        // selected window id
  // One entry per window: { id, label, sides: { left|right|top|bottom: { ok, reason } } }
  controls: { type: Array, default: () => [] },
  showControls: { type: Boolean, default: true },
  section: { type: Object, default: () => ({ mode: 'off', x_m: 0, y_m: 0 }) }, // mode: off|corner|vertical|horizontal
  explode: { type: Number, default: 0 },            // target 0..1 (eased here)
  ao: { type: Boolean, default: true },
  sectionCoreColor: { type: String, default: null }, // PVC core colour for cut faces
  scenery: { type: Boolean, default: true },         // wall, room, sky and ground (hidden in section / exploded views)
  showStats: { type: Boolean, default: true },
});
const emit = defineEmits(['select', 'add']);

const host = ref(null);
const stats = ref({ fps: 0, quality: QUALITY_LEVELS[0].name, idle: true });
let renderer, labelRenderer, scene, camera, aoCamera, controls, clock, resizeObs, frame = 0;
let composer, gtaoPass, keyLight, fillLight, ground, outline, scenery;
const STUDIO_BACKGROUND = new THREE.Color(0xe9ecf0);
let current = null, caps = null;
const prepared = new WeakSet(); // WindowModels whose meshes/materials were already set up for this renderer
let chips = []; // { id, label: CSS2DObject, adds: { side: CSS2DObject } }
let downAt = null;
let overlayZ = { front: 0, mid: 0 }; // chip / outline depth, from the bounds at the last fitStage
let explodeNow = 0;
let needsRender = true, needsShadow = true, lastRenderAt = 0, renderedLastFrame = false;
let fpsFrames = 0, fpsSince = 0;
const governor = new FrameGovernor({ targetFps: 60 });

// keep x <= cx  /  keep y <= cy
const planeX = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
const planeY = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
const planes = [planeX, planeY];

// Cut faces show the PVC core colour, slightly darkened so the section reads against the white faces.
const capTint = (hex) => new THREE.Color(hex || '#eeeeec').multiplyScalar(0.84);

/** Request a frame. Pass scene=true when geometry or transforms changed (the shadow map must update). */
function invalidate(sceneChanged = true) {
  needsRender = true;
  if (sceneChanged) needsShadow = true;
}

// Lighting (presentation only). The profile detail on PVC only reads if light is directional and rakes across the
// profile steps. Ambient (environment + hemisphere) is kept low, so faces turned away from the key are darker.
// The key comes from the upper left, the opposite side from the default camera (front right), so the shadows that
// the frame and sash steps cast into the reveals face the viewer. A weak fill from the right keeps those faces from
// going dead. Colours are unchanged: only the light on them is.
// 2026-11-23 retune (user: "too flat and too bright", then "too dark"): key more raking (lower z) and AO wider for
// relief; exposure back at 1.0 and ambient about three quarters of the original, so colours read at their normal
// brightness while faces turned away from the key stay clearly darker than the front faces.
const LIGHTING = {
  exposure: 1.0,
  environment: 0.28,
  hemisphere: 0.12,
  key: { intensity: 2.6, dir: [-0.95, 1.15, 0.6] },  // × stage radius, from the model centre
  fill: { intensity: 0.26, dir: [1, 0.25, 0.55] },
  groundShadow: 0.2,
  ao: { radius: 0.08, scale: 2.0, blend: 1.0 },
};

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps product colours close to their sRGB values
  renderer.toneMappingExposure = LIGHTING.exposure;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  host.value.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = STUDIO_BACKGROUND;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = LIGHTING.environment;

  keyLight = new THREE.DirectionalLight(0xffffff, LIGHTING.key.intensity);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0003;
  keyLight.shadow.normalBias = 0.0015;
  keyLight.shadow.radius = 3;
  scene.add(keyLight, keyLight.target);
  fillLight = new THREE.DirectionalLight(0xf3f6ff, LIGHTING.fill.intensity); // no shadows
  scene.add(fillLight, fillLight.target);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, LIGHTING.hemisphere));

  ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: LIGHTING.groundShadow }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  scenery = new Scenery();
  scenery.group.visible = false;
  scenery.group.traverse((o) => o.layers.set(LAYER_SCENERY));
  scene.add(scenery.group);

  camera = new THREE.PerspectiveCamera(35, 1, 0.02, 30);
  camera.layers.enable(LAYER_HELPERS);
  camera.layers.enable(LAYER_GLASS);
  camera.layers.enable(LAYER_SCENERY);
  aoCamera = camera.clone();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.addEventListener('change', () => invalidate(false)); // camera moves don't touch shadows

  // Post-processing: MSAA scene target (with stencil for section caps), then GTAO, then the output transform.
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, stencilBuffer: true });
  composer = new EffectComposer(renderer, rt);
  // Nothing reads these targets' depth or stencil after a pass: the section caps use the stencil inside the MSAA
  // render, and GTAO renders its own depth. Resolving them anyway (three.js' default) cost ~11 ms per pass on
  // ANGLE / D3D11 (measured 15 → 3.9 ms for the main pass, 19 → <1 ms for the AO blend). Colour is still resolved.
  for (const t of [composer.renderTarget1, composer.renderTarget2]) { t.resolveDepthBuffer = false; t.resolveStencilBuffer = false; }
  gtaoPass = new GTAOPass(scene, aoCamera, 1, 1);
  gtaoPass.updateGtaoMaterial({ radius: LIGHTING.ao.radius, distanceExponent: 1.5, thickness: 0.6, scale: LIGHTING.ao.scale, samples: 8 });
  gtaoPass.updatePdMaterial({ radius: 6, samples: 8 });
  gtaoPass.blendIntensity = LIGHTING.ao.blend;
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(gtaoPass);
  composer.addPass(new OutputPass());

  // DOM chips over the canvas. The layer ignores the pointer; only the chips themselves take clicks.
  labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'grid-chips';
  host.value.appendChild(labelRenderer.domElement);

  // Selected-window outline: a unit square scaled to the window, drawn over everything (presentation only).
  const sq = new THREE.BufferGeometry().setFromPoints([[0, 0], [1, 0], [1, 0], [1, 1], [1, 1], [0, 1], [0, 1], [0, 0]].map(([x, y]) => new THREE.Vector3(x, y, 0)));
  outline = new THREE.LineSegments(sq, new THREE.LineBasicMaterial({ color: 0x2563eb, depthTest: false, transparent: true }));
  outline.renderOrder = 5000;
  outline.layers.set(LAYER_HELPERS);
  outline.visible = false;
  scene.add(outline);

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  applyQuality(governor.level);
  // Dev server only (stripped from builds): handles for inspecting the renderer from the browser console.
  if (import.meta.env.DEV) window.__viewer = { renderer, scene, camera, controls, composer, gtaoPass, keyLight, fillLight, invalidate, governor, surfaceDetail: surfaceDetailUniforms, get current() { return current; } };
  clock = new THREE.Clock();
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(host.value);
  resize();
  loop();
}

function applyQuality(level) {
  const q = QUALITY_LEVELS[level];
  const pr = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  for (const t of [composer.renderTarget1, composer.renderTarget2]) {
    if (t.samples !== q.msaa) { t.samples = q.msaa; t.dispose(); }
  }
  stats.value.quality = q.name;
  resize();
  invalidate(false);
}

function resize() {
  const { clientWidth: w, clientHeight: h } = host.value;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  invalidate(false);
}

function loop(now = performance.now()) {
  frame = requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (current) {
    if (current.isAnimating()) {
      current.update(dt);
      invalidate(true); // sashes moved
    }
    if (explodeNow !== props.explode) {
      const k = 1 - Math.exp(-dt * 7);
      explodeNow += (props.explode - explodeNow) * k;
      if (Math.abs(explodeNow - props.explode) < 1e-3) explodeNow = props.explode;
      current.setExplode(explodeNow);
      fitStage();
    }
  }
  controls.update(); // emits 'change' (→ invalidate) while orbiting or damping

  if (!needsRender) {
    renderedLastFrame = false;
    if (!stats.value.idle && now - lastRenderAt > 500) stats.value = { ...stats.value, idle: true };
    return;
  }

  // Frame pacing: only consecutive rendered frames measure real throughput.
  if (renderedLastFrame) {
    const changed = governor.sample(now - lastRenderAt);
    if (changed !== null) applyQuality(changed);
  }
  if (renderedLastFrame) fpsFrames++; else { fpsFrames = 0; fpsSince = now; }
  if (now - fpsSince >= 500 && fpsFrames > 0) {
    stats.value = { ...stats.value, fps: Math.round((fpsFrames * 1000) / (now - fpsSince)), idle: false };
    fpsFrames = 0; fpsSince = now;
  }

  if (needsShadow) { renderer.shadowMap.needsUpdate = true; needsShadow = false; }
  aoCamera.copy(camera);
  aoCamera.layers.set(0); // AO sees the opaque model, ground and scenery (no glass, no section helpers)
  aoCamera.layers.enable(LAYER_SCENERY);
  gtaoPass.enabled = props.ao && QUALITY_LEVELS[governor.level].ao && props.section.mode === 'off';
  needsRender = false;
  placeOverlays();
  composer.render(dt);
  labelRenderer.render(scene, camera);
  lastRenderAt = now;
  renderedLastFrame = true;
}

/**
 * Wall, room, sky and ground. Shown only in the assembled, uncut view: an exploded or sectioned window would
 * intersect the wall. Rebuilt only when the window layout or depth changes. Presentation only.
 */
function updateScenery() {
  if (!scenery) return false;
  const show = Boolean(current?.units.length) && props.scenery && props.section.mode === 'off' && props.explode === 0 && explodeNow === 0;
  if (show) {
    const rects = [...current.rects().values()].map((r) => ({ x: inToM(r.x), y: inToM(r.y), w: inToM(r.w), h: inToM(r.h) }));
    scenery.update(rects, current.restDepth_m());
  }
  scenery.group.visible = show;
  ground.visible = !show;
  scene.background = show ? scenery.horizon : STUDIO_BACKGROUND; // a Color: a texture background breaks GTAO
  return show;
}

/** Ground and shadow camera follow the model's current bounds (size and explode change them). */
function fitStage() {
  if (!current) return;
  const withScenery = updateScenery();
  const b = current.getBounds();
  const s = b.getSize(new THREE.Vector3());
  const c = b.getCenter(new THREE.Vector3());
  ground.position.y = b.min.y - 0.0005;
  // With the wall shown, the shadow camera also reaches the reveals and the sunlit patch on the room floor.
  const r = Math.max(s.x, s.y, s.z) * 0.9 + (withScenery ? 1.2 : 0.2);
  const [kx, ky, kz] = LIGHTING.key.dir, [fx, fy, fz] = LIGHTING.fill.dir;
  keyLight.position.set(c.x + r * kx, c.y + r * ky, c.z + r * kz);
  keyLight.target.position.copy(c);
  fillLight.position.set(c.x + r * fx, c.y + r * fy, c.z + r * fz);
  fillLight.target.position.copy(c);
  const sc = keyLight.shadow.camera;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 0.01; sc.far = r * 6;
  sc.updateProjectionMatrix();
  gtaoPass.setSceneClipBox(b.clone().expandByScalar(0.3));
  overlayZ = { front: b.max.z + 0.002, mid: (b.min.z + b.max.z) / 2 };
  invalidate(true);
}

function prepareModel(model) {
  if (prepared.has(model)) return;
  prepared.add(model);
  for (const p of model.parts) {
    for (const { mesh } of p.meshes) {
      mesh.renderOrder = 1000; // after all section stencil/cap draws
      const glass = p.cfg.role === 'glass';
      mesh.castShadow = !glass;
      mesh.receiveShadow = !glass;
      if (glass) mesh.layers.set(LAYER_GLASS);
      // PVC only: fine grain and roughness variation so large faces are not perfectly smooth (presentation only).
      if (p.cfg.role === 'profile') applySurfaceDetail(mesh.material);
    }
  }
  for (const m of model.materials()) {
    m.clipShadows = true;
    // Every part is a closed, outward-wound solid (verified), so casting shadows from back faces only
    // removes the self-shadow acne that the GLB's double-sided materials otherwise produce.
    m.shadowSide = THREE.BackSide;
    if (m.transmission > 0) {
      // Glass: drop the transmission pass (a second full-scene render per frame) and use the GLB's
      // own alpha blend (BLEND, opacity 0.25) with environment reflections. This is presentation only.
      m.transmission = 0;
      m.transparent = true;
      m.depthWrite = false;
      m.roughness = 0.03;
      m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
  }
}

/** Section caps over every window's meshes. Rebuilt whenever windows are added, removed or replaced. */
function buildCaps() {
  caps?.dispose();
  caps = null;
  if (!current) return;
  const g = current.capGroups();
  caps = new SectionCaps(scene, planes, [
    { key: 'pvc', color: capTint(props.sectionCoreColor), roughness: 0.7, meshes: g.pvc },
    { key: 'glass', color: '#b7cdc8', roughness: 0.2, meshes: g.glass },
    { key: 'gasket', color: '#1c1c1e', roughness: 0.8, meshes: g.gasket },
    // Hinge hardware (Casement_V3+) is closed prisms too. Only added when present, so other GLBs keep the same passes.
    ...(g.hardware.length ? [{ key: 'hardware', color: '#8d9096', roughness: 0.45, meshes: g.hardware }] : []),
  ]);
}

function attach(assembly) {
  caps?.dispose();
  caps = null;
  if (current) scene.remove(current.scene);
  current = assembly;
  explodeNow = 0;
  buildChips();
  if (!assembly) { invalidate(); return; }
  explodeNow = assembly.explode;
  scene.add(assembly.scene);
  rebuild();
  view('exterior');
}

/** Windows were added, removed or replaced: set up new models, rebuild the caps, re-apply the section. */
function rebuild() {
  if (!current) return;
  current.models.forEach(prepareModel);
  buildCaps();
  applySection();
  fitStage();
}

// ---------- grid chips, selection ----------

const ICON_PLUS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SIDE_WORD = { left: 'left of', right: 'right of', top: 'above', bottom: 'below' };

function chip(className, html, title, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.innerHTML = html;
  el.title = title;
  el.setAttribute('aria-label', title);
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  const obj = new CSS2DObject(el);
  scene.add(obj);
  return obj;
}

function clearChips() {
  for (const c of chips) {
    for (const o of [c.label, ...Object.values(c.adds)]) { scene.remove(o); o.element.remove(); }
  }
  chips = [];
}

/** (Re)create the chips from the controls prop. Only blocked sides get no + (their reason is in the panel). */
function buildChips() {
  if (!scene) return;
  clearChips();
  if (!current) return;
  for (const c of props.controls) {
    const label = chip('gz-label', c.label, `Select ${c.label}`, () => emit('select', c.id));
    const adds = {};
    for (const [side, s] of Object.entries(c.sides)) {
      if (!s.ok) continue;
      adds[side] = chip(`gz-add gz-${side}`, ICON_PLUS, `Add a window ${SIDE_WORD[side]} ${c.label}`, () => emit('add', { id: c.id, side }));
    }
    chips.push({ id: c.id, label, adds });
  }
  placeOverlays();
  invalidate(false);
}

/** Anchor the chips and the outline to the current (possibly exploded) window rectangles. */
function placeOverlays() {
  if (!current || !current.units.length) { outline.visible = false; return; }
  const { front: zFront, mid: zMid } = overlayZ;
  for (const c of chips) {
    if (!current.get(c.id)) continue;
    const r = current.worldRect(c.id);
    const show = props.showControls;
    c.label.visible = show;
    c.label.element.classList.toggle('on', c.id === props.selected);
    c.label.position.set(r.x + r.w / 2, r.y + r.h / 2, zMid);
    const at = { left: [r.x, r.y + r.h / 2], right: [r.x + r.w, r.y + r.h / 2], top: [r.x + r.w / 2, r.y + r.h], bottom: [r.x + r.w / 2, r.y] };
    for (const [side, o] of Object.entries(c.adds)) {
      o.visible = show;
      o.position.set(at[side][0], at[side][1], zMid);
    }
  }
  const sel = props.selected != null && current.get(props.selected) ? current.worldRect(props.selected) : null;
  outline.visible = Boolean(sel) && props.showControls;
  if (sel) {
    outline.position.set(sel.x, sel.y, zFront);
    outline.scale.set(sel.w, sel.h, 1);
  }
}

function onPointerDown(e) { downAt = { x: e.clientX, y: e.clientY }; }

/** A click (not an orbit drag) on a window selects it. */
function onPointerUp(e) {
  if (!downAt || !current) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.layers.set(0);
  ray.layers.enable(LAYER_GLASS);
  ray.setFromCamera(ndc, camera);
  for (const hit of ray.intersectObject(current.scene, true)) {
    if (hit.object.userData.sectionHelper) continue;
    for (let o = hit.object; o; o = o.parent) {
      if (o.userData.windowId != null) { emit('select', o.userData.windowId); return; }
    }
  }
}

function applySection() {
  if (!current) return;
  const { mode, x_m, y_m } = props.section;
  const active = [mode === 'corner' || mode === 'vertical', mode === 'corner' || mode === 'horizontal'];
  planeX.constant = x_m;
  planeY.constant = y_m;
  const clip = planes.filter((_, i) => active[i]);
  for (const m of current.materials()) m.clippingPlanes = clip;
  caps?.update(active);
  invalidate(true);
}

/** Camera presets. Exterior faces +Z in the GLB (root cfg axes.exteriorFacing). */
function view(side = 'exterior') {
  if (!current) return;
  const b = current.getBounds();
  let target = b.getCenter(new THREE.Vector3());
  let size = b.getSize(new THREE.Vector3());
  let dir;
  if (side === 'section' && props.section.mode !== 'off') {
    const { mode, x_m, y_m } = props.section;
    // Frame the kept region, looking at the cut face(s).
    const kept = b.clone();
    if (mode !== 'horizontal') kept.max.x = Math.min(kept.max.x, x_m);
    if (mode !== 'vertical') kept.max.y = Math.min(kept.max.y, y_m);
    target = kept.getCenter(new THREE.Vector3());
    size = kept.getSize(new THREE.Vector3());
    dir = mode === 'corner' ? new THREE.Vector3(1, 0.8, 0.9)
      : mode === 'vertical' ? new THREE.Vector3(1, 0.25, 0.55)
      : new THREE.Vector3(0.35, 1, 0.6);
  } else {
    dir = side === 'interior' ? new THREE.Vector3(-0.35, 0.15, -1) : new THREE.Vector3(0.35, 0.15, 1);
  }
  const fit = Math.max(size.x / camera.aspect, size.y, size.z) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  const dist = fit * 1.45 + Math.min(size.z, 0.3);
  camera.position.copy(target).addScaledVector(dir.normalize(), dist);
  controls.target.copy(target);
  controls.update();
  invalidate(false);
}

/** After a size change: keep the user's orbit, but follow the window's centre. */
function recenter() {
  if (!current) return;
  const c = current.getBounds().getCenter(new THREE.Vector3());
  const delta = c.clone().sub(controls.target);
  controls.target.add(delta);
  camera.position.add(delta);
  fitStage();
}

/** After windows were added or removed: keep the viewing direction, re-aim at the centre and fit the distance. */
function fit() {
  if (!current) return;
  const b = current.getBounds();
  const target = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3());
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-12) dir.set(0.35, 0.15, 1);
  const f = Math.max(size.x / camera.aspect, size.y, size.z) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.copy(target).addScaledVector(dir.normalize(), f * 1.45 + Math.min(size.z, 0.3));
  controls.target.copy(target);
  controls.update();
  fitStage();
}

watch(() => props.assembly, attach);
watch(() => props.version, () => { rebuild(); buildChips(); });
watch(() => props.controls, buildChips);
watch(() => [props.selected, props.showControls], () => { placeOverlays(); invalidate(false); });
watch(() => props.section, applySection, { deep: true });
watch(() => [props.scenery, props.section.mode], fitStage); // shows / hides the wall and refits the shadow camera
watch(() => props.sectionCoreColor, (c) => { caps?.setColor('pvc', capTint(c)); invalidate(false); });
watch(() => [props.ao, props.explode], () => invalidate(false));
onMounted(() => { init(); attach(props.assembly); });
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObs?.disconnect();
  renderer?.domElement.removeEventListener('pointerdown', onPointerDown);
  renderer?.domElement.removeEventListener('pointerup', onPointerUp);
  clearChips();
  caps?.dispose();
  scenery?.dispose();
  controls?.dispose();
  composer?.dispose();
  renderer?.dispose();
});

defineExpose({ view, recenter, fit, invalidate });
</script>

<template>
  <div ref="host" class="viewer"></div>
  <div v-if="showStats" class="stats">{{ stats.idle ? 'idle' : `${stats.fps} fps` }} · {{ stats.quality }}</div>
</template>

<style scoped>
.viewer { position: absolute; inset: 0; }
.viewer :deep(canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
.viewer :deep(.grid-chips) { position: absolute; top: 0; left: 0; pointer-events: none; }
.viewer :deep(.gz-label), .viewer :deep(.gz-add) {
  pointer-events: auto; cursor: pointer; border: 1px solid #c9ced6; background: rgba(255, 255, 255, 0.92);
  color: #1d232b; font: 600 12px system-ui, sans-serif; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}
.viewer :deep(.gz-label) { padding: 3px 8px; border-radius: 999px; }
.viewer :deep(.gz-label.on) { background: #2563eb; border-color: #2563eb; color: #fff; }
.viewer :deep(.gz-add) { width: 24px; height: 24px; padding: 0; border-radius: 50%; display: grid; place-items: center; color: #2563eb; }
.viewer :deep(.gz-label:hover), .viewer :deep(.gz-add:hover) { border-color: #2563eb; }
.viewer :deep(.gz-add:hover) { background: #2563eb; color: #fff; }
.stats {
  position: absolute; right: 12px; bottom: 12px; font: 12px ui-monospace, Consolas, monospace;
  color: #4b5563; background: rgba(255, 255, 255, 0.8); padding: 3px 7px; border-radius: 6px; pointer-events: none;
}
</style>
