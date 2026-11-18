<script setup>
// Pure renderer. It owns the three.js scene, camera, post-processing, section planes and the explode
// easing, and draws whatever WindowModel it is given. It never feeds anything back into the model's
// dimensions. Everything here is presentation.
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
import { SectionCaps, LAYER_HELPERS } from '../configurator/SectionCaps.js';
import { FrameGovernor, QUALITY_LEVELS } from '../configurator/FrameGovernor.js';

const LAYER_GLASS = 3; // rendered, but kept out of the AO normal pass

const props = defineProps({
  model: { type: Object, default: null },          // WindowModel (markRaw'd by the parent)
  section: { type: Object, default: () => ({ mode: 'off', x_m: 0, y_m: 0 }) }, // mode: off|corner|vertical|horizontal
  explode: { type: Number, default: 0 },            // target 0..1 (eased here)
  ao: { type: Boolean, default: true },
  sectionCoreColor: { type: String, default: null }, // PVC core colour for cut faces
  showStats: { type: Boolean, default: true },
});

const host = ref(null);
const stats = ref({ fps: 0, quality: QUALITY_LEVELS[0].name, idle: true });
let renderer, scene, camera, aoCamera, controls, clock, resizeObs, frame = 0;
let composer, gtaoPass, keyLight, ground;
let current = null, caps = null;
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

function init() {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.NeutralToneMapping; // keeps product colours close to their sRGB values
  renderer.toneMappingExposure = 0.92;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  host.value.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9ecf0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.6;

  keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  keyLight.shadow.bias = -0.0003;
  keyLight.shadow.normalBias = 0.0015;
  keyLight.shadow.radius = 3;
  scene.add(keyLight, keyLight.target);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 0.35));

  ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.12 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  camera = new THREE.PerspectiveCamera(35, 1, 0.02, 30);
  camera.layers.enable(LAYER_HELPERS);
  camera.layers.enable(LAYER_GLASS);
  aoCamera = camera.clone();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.addEventListener('change', () => invalidate(false)); // camera moves don't touch shadows

  // Post-processing: MSAA scene target (with stencil for section caps), then GTAO, then the output transform.
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, stencilBuffer: true });
  composer = new EffectComposer(renderer, rt);
  gtaoPass = new GTAOPass(scene, aoCamera, 1, 1);
  gtaoPass.updateGtaoMaterial({ radius: 0.035, distanceExponent: 1.5, thickness: 0.6, scale: 1.1, samples: 8 });
  gtaoPass.updatePdMaterial({ radius: 6, samples: 8 });
  gtaoPass.blendIntensity = 0.9;
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(gtaoPass);
  composer.addPass(new OutputPass());

  applyQuality(governor.level);
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
  aoCamera.layers.set(0); // AO sees opaque model + ground only (no glass, no section helpers)
  gtaoPass.enabled = props.ao && QUALITY_LEVELS[governor.level].ao && props.section.mode === 'off';
  needsRender = false;
  composer.render(dt);
  lastRenderAt = now;
  renderedLastFrame = true;
}

/** Ground and shadow camera follow the model's current bounds (size and explode change them). */
function fitStage() {
  if (!current) return;
  const b = current.getBounds();
  const s = b.getSize(new THREE.Vector3());
  const c = b.getCenter(new THREE.Vector3());
  ground.position.y = b.min.y - 0.0005;
  const r = Math.max(s.x, s.y, s.z) * 0.9 + 0.2;
  keyLight.position.set(c.x + r * 0.8, c.y + r * 1.4, c.z + r * 1.3);
  keyLight.target.position.copy(c);
  const sc = keyLight.shadow.camera;
  sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 0.01; sc.far = r * 6;
  sc.updateProjectionMatrix();
  gtaoPass.setSceneClipBox(b.clone().expandByScalar(0.3));
  invalidate(true);
}

function prepareModel(model) {
  for (const p of model.parts) {
    for (const { mesh } of p.meshes) {
      mesh.renderOrder = 1000; // after all section stencil/cap draws
      const glass = p.cfg.role === 'glass';
      mesh.castShadow = !glass;
      mesh.receiveShadow = !glass;
      if (glass) mesh.layers.set(LAYER_GLASS);
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
  const g = model.capGroups();
  caps = new SectionCaps(scene, planes, [
    { key: 'pvc', color: capTint(props.sectionCoreColor), roughness: 0.7, meshes: g.pvc },
    { key: 'glass', color: '#b7cdc8', roughness: 0.2, meshes: g.glass },
    { key: 'gasket', color: '#1c1c1e', roughness: 0.8, meshes: g.gasket },
    // Hinge hardware (Casement_V3+) is closed prisms too. Only added when present, so other GLBs keep the same passes.
    ...(g.hardware.length ? [{ key: 'hardware', color: '#8d9096', roughness: 0.45, meshes: g.hardware }] : []),
  ]);
}

function attach(model) {
  caps?.dispose();
  caps = null;
  if (current) scene.remove(current.scene);
  current = model;
  explodeNow = 0;
  if (!model) { invalidate(); return; }
  prepareModel(model);
  explodeNow = model.explode;
  scene.add(model.scene);
  applySection();
  fitStage();
  view('exterior');
}

function applySection() {
  if (!current) return;
  const { mode, x_m, y_m } = props.section;
  const active = [mode === 'corner' || mode === 'vertical', mode === 'corner' || mode === 'horizontal'];
  planeX.constant = x_m;
  planeY.constant = y_m;
  const clip = planes.filter((_, i) => active[i]);
  for (const m of current.materials()) m.clippingPlanes = clip;
  caps.update(active);
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

watch(() => props.model, attach);
watch(() => props.section, applySection, { deep: true });
watch(() => props.sectionCoreColor, (c) => { caps?.setColor('pvc', capTint(c)); invalidate(false); });
watch(() => [props.ao, props.explode], () => invalidate(false));
onMounted(() => { init(); attach(props.model); });
onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObs?.disconnect();
  caps?.dispose();
  controls?.dispose();
  composer?.dispose();
  renderer?.dispose();
});

defineExpose({ view, recenter, invalidate });
</script>

<template>
  <div ref="host" class="viewer"></div>
  <div v-if="showStats" class="stats">{{ stats.idle ? 'idle' : `${stats.fps} fps` }} · {{ stats.quality }}</div>
</template>

<style scoped>
.viewer { position: absolute; inset: 0; }
.viewer :deep(canvas) { display: block; width: 100%; height: 100%; touch-action: none; }
.stats {
  position: absolute; right: 12px; bottom: 12px; font: 12px ui-monospace, Consolas, monospace;
  color: #4b5563; background: rgba(255, 255, 255, 0.8); padding: 3px 7px; border-radius: 6px; pointer-events: none;
}
</style>
