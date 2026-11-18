<script setup>
import { ref, shallowRef, markRaw, computed, watch, onMounted, nextTick } from 'vue';
import WindowViewer from './components/WindowViewer.vue';
import { loadGltf, WindowModel, ConfigError } from './configurator/WindowModel.js';
import { WindowAssembly } from './configurator/WindowAssembly.js';
import { SIDES } from './configurator/assembly.js';
import { inToM, mToIn } from './configurator/deform.js';

// ---- POC-only UI constants (NOT product data) ---------------------------------
// Upper bounds for the sliders. Real product size limits must come from product data.
const VISUAL_MAX_IN = { width: 72, height: 96 };
// Quick-pick swatches for the preview. NOT the product colour catalogue.
const PREVIEW_SWATCHES = [
  { name: 'White', hex: '#f2f2ee' },
  { name: 'Almond', hex: '#e6dcc6' },
  { name: 'Sandstone', hex: '#c8b596' },
  { name: 'Clay', hex: '#8c7d69' },
  { name: 'Bronze', hex: '#4e3c2c' },
  { name: 'Black', hex: '#202020' },
];
const IN_STEP = 0.125;
// GLBs shipped in ./public, offered as window types (any other GLB: ?model= or "Load GLB…").
const BUNDLED_MODELS = [
  { file: 'Window_V3_cfg.glb', label: 'Double-hung (Window_V3)' },
  { file: 'Casement_V4_cfg.glb', label: 'Casement (Casement_V4)' },
];
// --------------------------------------------------------------------------------

// Optional URL params for sharing a preview of the first window: ?model=&w=&h=&ext=&int=&view=interior
const QS = new URLSearchParams(location.search);
const DEFAULT_MODEL = QS.get('model') || 'Window_V3_cfg.glb';
const HEX = /^#[0-9a-f]{6}$/i;
const ZONES = ['exterior', 'interior'];
const SIDE_LABEL = { left: '← Left', right: 'Right →', top: '↑ Above', bottom: '↓ Below' };

const viewer = ref(null);
const assembly = shallowRef(null); // WindowAssembly (markRaw)
const version = ref(0);  // windows added / removed / replaced: the viewer rebuilds caps and chips
const rev = ref(0);      // anything the panel shows changed (sizes, colours, structure)
const touch = () => { rev.value++; };
const selectedId = ref(null);
const loadError = ref(null);   // { message, errors[] } when nothing could be shown at all
const typeError = ref(null);   // { message, errors[] } for a failed add / type change (the old state stays)
const loading = ref(false);
const busy = ref(false);
const showControls = ref(true);

// Window types: key -> { label, source }. Buffers are fetched once; every window parses its own copy.
const types = ref(BUNDLED_MODELS.map((m) => ({ key: m.file, label: m.label, source: `./${m.file}` })));
if (!types.value.some((t) => t.key === DEFAULT_MODEL)) types.value.push({ key: DEFAULT_MODEL, label: DEFAULT_MODEL, source: `./${DEFAULT_MODEL}` });
const buffers = new Map();

// A fresh snapshot per revision. The units themselves are plain (non-reactive) objects that are mutated in place,
// so returning the same object would not notify the template after a resize or recolour.
const sel = computed(() => {
  rev.value;
  const u = assembly.value?.get(selectedId.value);
  return u ? { ...u, colors: { ...u.colors }, type: { ...u.type } } : null;
});
const selModel = computed(() => sel.value?.model ?? null);
const selLabel = computed(() => (sel.value ? `W${sel.value.id}` : ''));
const units = computed(() => { rev.value; return assembly.value?.units.map((u) => ({ id: u.id, label: `W${u.id}`, type: u.type.label })) ?? []; });

const widthText = ref('24');
const heightText = ref('36');
const sizeError = ref('');

const playing = ref(false);
const paused = ref(false);
const loop = ref(false);
const speed = ref(1);
const showParts = ref(false);

// ---- presentation: explode / section / AO ----
const explode = ref(0);
const ao = ref(true);
const sectionMode = ref('off'); // off | corner | vertical | horizontal
const cutXIn = ref(4.5); // from the left edge of the whole layout
const cutYIn = ref(4.5); // from the bottom edge of the whole layout
const SECTION_MODES = [
  { id: 'off', label: 'Off' },
  { id: 'corner', label: 'Corner' },
  { id: 'vertical', label: 'Vertical', title: 'Vertical cut: head, meeting rail and sill profiles' },
  { id: 'horizontal', label: 'Horizontal', title: 'Horizontal cut: jamb and stile profiles' },
];
// Overall extents of the frame outside sizes (in). NOT an order or mulled-unit dimension: joints are not modelled.
const ext = computed(() => { rev.value; return assembly.value?.units.length ? assembly.value.extents() : { minX: 0, minY: 0, maxX: 24, maxY: 36, w: 24, h: 36 }; });
const selRect = computed(() => { rev.value; return sel.value ? assembly.value.rects().get(sel.value.id) : null; });
const sectionProp = computed(() => ({ mode: sectionMode.value, x_m: inToM(ext.value.minX + cutXIn.value), y_m: inToM(ext.value.minY + cutYIn.value) }));
const coreColor = computed(() => selModel.value?.initialColors.exterior ?? selModel.value?.initialColors.interior ?? null);
async function setSectionMode(mode) {
  // Starting positions when entering a mode, on the selected window (presentation only).
  const r = selRect.value ?? { x: ext.value.minX, y: ext.value.minY, w: ext.value.w, h: ext.value.h };
  const ox = r.x - ext.value.minX, oy = r.y - ext.value.minY;
  if (mode === 'corner') { cutXIn.value = ox + 4.5; cutYIn.value = oy + 4.5; }
  if (mode === 'vertical') cutXIn.value = ox + r.w / 2;
  if (mode === 'horizontal') cutYIn.value = oy + r.h / 4; // a stile, away from the meeting rail
  sectionMode.value = mode;
  await nextTick();
  viewer.value?.view(mode === 'off' ? 'exterior' : 'section');
}

const limitsOf = (m) => {
  // Round the geometric collapse limit UP to the next input step, so it is never crossed.
  const up = (v) => Math.ceil(v / IN_STEP) * IN_STEP + IN_STEP;
  return { minW: up(mToIn(m.limits.minWidth_m)), minH: up(mToIn(m.limits.minHeight_m)), maxW: VISUAL_MAX_IN.width, maxH: VISUAL_MAX_IN.height };
};
const limits = computed(() => (selModel.value ? limitsOf(selModel.value) : { minW: 1, minH: 1, maxW: VISUAL_MAX_IN.width, maxH: VISUAL_MAX_IN.height }));
// Fixed-size hinge hardware (Casement_V3+) extends past the frame below this size. Warning only: the
// hinge maker's real size range is not in the GLB data, so nothing is blocked on it.
const hardwareWarning = computed(() => {
  const L = selModel.value?.limits;
  const u = sel.value;
  if (!L || !u) return '';
  const over = [];
  if (L.hardwareFitWidth_m != null && inToM(u.w) < L.hardwareFitWidth_m) over.push(`width < ${mToIn(L.hardwareFitWidth_m).toFixed(2)} in`);
  if (L.hardwareFitHeight_m != null && inToM(u.h) < L.hardwareFitHeight_m) over.push(`height < ${mToIn(L.hardwareFitHeight_m).toFixed(2)} in`);
  return over.length ? `At ${over.join(' and ')}, the preview's fixed-size hinge hardware extends past the frame. The hinge's real size range is not in the GLB data.` : '';
});
const windowType = computed(() => selModel.value?.rootCfg.windowType ?? null);
const refSizeOf = (m) => ({ w: m.rootCfg.reference.width_in ?? mToIn(m.ref.width_m), h: m.rootCfg.reference.height_in ?? mToIn(m.ref.height_m) });
const refSizeIn = computed(() => (selModel.value ? refSizeOf(selModel.value) : { w: 24, h: 36 }));
const fmtMm = (inch) => (inch * 25.4).toFixed(1);
const fmtIn = (v) => String(Number(v.toFixed(3)));
const zones = computed(() => ZONES.filter((z) => selModel.value?.initialColors[z] !== undefined));
const parts = computed(() => selModel.value?.describeParts() ?? []);

// + availability for every side of every window (shown as chips in the viewer and as buttons in the panel).
// A new window copies the size of the window it is added to, so that is the size checked here.
const gridControls = computed(() => {
  rev.value;
  const a = assembly.value;
  if (!a) return [];
  return a.units.map((u) => ({
    id: u.id,
    label: `W${u.id}`,
    sides: Object.fromEntries(SIDES.map((s) => { const c = a.checkAdd(u.id, s, u.w, u.h); return [s, { ok: c.ok, reason: c.reason }]; })),
  }));
});
const selSides = computed(() => gridControls.value.find((c) => c.id === selectedId.value)?.sides ?? null);
const removeCheck = computed(() => { rev.value; return sel.value ? assembly.value.checkRemove(sel.value.id) : { ok: false, reason: '' }; });

// ---- loading ----
async function fetchGlb(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} loading ${url}`);
  const buf = await res.arrayBuffer();
  // Vite's SPA fallback returns index.html with 200 for missing files; check the GLB magic.
  if (buf.byteLength < 12 || new DataView(buf).getUint32(0, true) !== 0x46546c67) {
    throw new Error(`not found or not a GLB. Put the file in configurator/public/ or use "Load GLB…"`);
  }
  return buf;
}

/** A new, independent WindowModel of type `key` (its own geometry, materials and animation clips). */
async function makeModel(key) {
  const t = types.value.find((x) => x.key === key);
  if (!t) throw new Error(`Unknown window type ${key}`);
  if (!buffers.has(key)) buffers.set(key, await fetchGlb(t.source));
  const gltf = await loadGltf(buffers.get(key).slice(0));
  const m = markRaw(new WindowModel(gltf));
  m.mixer.addEventListener('finished', () => { if (!assembly.value?.isAnimating()) playing.value = false; });
  return m;
}
const typeOf = (key) => { const t = types.value.find((x) => x.key === key); return { key: t.key, label: t.label }; };
const errorInfo = (e, name) => ({ message: `${name}: ${e.message}`, errors: e instanceof ConfigError ? e.errors : [] });

/** Start over with one window of type `key`, at its reference size and GLB colours. */
async function startWith(key) {
  loading.value = true;
  loadError.value = null;
  typeError.value = null;
  try {
    const m = await makeModel(key);
    const a = markRaw(new WindowAssembly());
    const r = refSizeOf(m);
    const id = a.add(m, { w: r.w, h: r.h, type: typeOf(key), colors: { ...m.initialColors } });
    assembly.value?.dispose();
    assembly.value = a;
    selectedId.value = id;
    syncSizeText();
    playing.value = false; paused.value = false;
    version.value++; touch();
  } catch (e) {
    loadError.value = errorInfo(e, key);
  } finally {
    loading.value = false;
  }
}

function onFile(ev) {
  const f = ev.target.files?.[0];
  ev.target.value = '';
  if (!f) return;
  f.arrayBuffer().then((buf) => {
    const key = `upload:${f.name}`;
    buffers.set(key, buf);
    const existing = types.value.find((t) => t.key === key);
    if (!existing) types.value.push({ key, label: `${f.name} (file)`, source: null });
    if (assembly.value && sel.value) changeType(key);
    else startWith(key);
  });
}

// ---- windows: select / add / remove / type ----
function select(id) {
  if (!assembly.value?.get(id)) return;
  selectedId.value = id;
  typeError.value = null;
}
/** Size inputs show the selected window's stored size (after selecting, adding, removing or starting over). */
function syncSizeText() {
  const u = assembly.value?.get(selectedId.value);
  if (!u) return;
  widthText.value = fmtIn(u.w); heightText.value = fmtIn(u.h);
  sizeError.value = '';
}
watch(selectedId, syncSizeText);

/** Add a window on `side` of window `id`. It copies that window's type, size and colours; then customise it. */
async function addWindow({ id, side }) {
  const a = assembly.value;
  const src = a?.get(id);
  if (!src || busy.value) return;
  const c = a.checkAdd(id, side, src.w, src.h);
  if (!c.ok) { typeError.value = { message: `Cannot add a window ${side} of W${id}: ${c.reason}`, errors: [] }; return; }
  busy.value = true;
  typeError.value = null;
  let m = null;
  try {
    m = await makeModel(src.type.key);
    const newId = a.add(m, { parent: id, side, w: src.w, h: src.h, type: { ...src.type }, colors: { ...src.colors } });
    m = null;
    selectedId.value = newId;
    version.value++; touch();
    await nextTick();
    viewer.value?.fit();
  } catch (e) {
    m?.dispose();
    typeError.value = errorInfo(e, `Add window ${side} of W${id}`);
  } finally {
    busy.value = false;
  }
}

function removeSelected() {
  const a = assembly.value, u = sel.value;
  if (!a || !u) return;
  const c = a.checkRemove(u.id);
  if (!c.ok) return;
  const next = c.newRoot ?? u.parent;
  a.remove(u.id);
  selectedId.value = next;
  playing.value = a.isAnimating();
  version.value++; touch();
  nextTick(() => viewer.value?.fit());
}

/** Change the selected window's type. It keeps its place, size and colours; blocked if the new type can't take that size. */
async function changeType(key) {
  const a = assembly.value, u = sel.value;
  if (!a || !u || key === u.type.key || busy.value) return;
  busy.value = true;
  typeError.value = null;
  let m = null;
  try {
    m = await makeModel(key);
    a.replaceModel(u.id, m, typeOf(key));
    m = null;
    playing.value = a.isAnimating();
    version.value++; touch();
  } catch (e) {
    m?.dispose();
    typeError.value = errorInfo(e, `W${u.id} → ${typeOf(key).label}`);
    touch(); // re-render so the type picker shows the type the window still has
  } finally {
    busy.value = false;
  }
}

// ---- size (selected window) ----
function setSize(w, h) {
  const a = assembly.value, u = sel.value;
  if (!a || !u) return;
  const L = limits.value;
  const problems = [];
  if (!Number.isFinite(w) || w < L.minW || w > L.maxW) problems.push(`width must be ${L.minW}–${L.maxW} in`);
  if (!Number.isFinite(h) || h < L.minH || h > L.maxH) problems.push(`height must be ${L.minH}–${L.maxH} in`);
  if (problems.length) { sizeError.value = problems.join('; '); return; } // block, never auto-clamp
  const c = a.checkResize(u.id, w, h);
  if (!c.ok) { sizeError.value = `Blocked: ${c.reason}`; return; }   // block, never push other windows aside
  try { a.setSize(u.id, w, h); } catch (e) { sizeError.value = e.message; return; }
  sizeError.value = '';
  widthText.value = fmtIn(w); heightText.value = fmtIn(h);
  touch();
  viewer.value?.recenter();
}
const commitText = () => setSize(parseFloat(widthText.value), parseFloat(heightText.value));
const resetSize = () => setSize(refSizeIn.value.w, refSizeIn.value.h);

// ---- colours (selected window) ----
function setColor(zone, hex) {
  if (!sel.value || !HEX.test(hex)) return;
  assembly.value.setColor(sel.value.id, zone, hex);
  touch();
  viewer.value?.invalidate(false);
}

// ---- animation ----
function play(clip) {
  if (!selModel.value) return;
  assembly.value.setPaused(false);
  selModel.value.play(clip, { loop: loop.value, timeScale: speed.value });
  playing.value = true; paused.value = false;
}
function playAll() {
  const a = assembly.value;
  if (!a) return;
  a.setPaused(false);
  for (const m of a.models) m.play(null, { loop: loop.value, timeScale: speed.value });
  playing.value = true; paused.value = false;
}
function togglePause() { paused.value = !paused.value; assembly.value?.setPaused(paused.value); }
function closeSelected() {
  selModel.value?.stop();
  playing.value = assembly.value?.isAnimating() ?? false;
  if (!playing.value) paused.value = false;
  viewer.value?.invalidate(true);
}
function closeAll() { assembly.value?.stop(); playing.value = false; paused.value = false; viewer.value?.invalidate(true); }
watch(speed, (s) => assembly.value?.setTimeScale(s));

onMounted(async () => {
  await startWith(DEFAULT_MODEL);
  if (!assembly.value) return;
  if (QS.has('w') || QS.has('h')) setSize(parseFloat(QS.get('w') ?? sel.value.w), parseFloat(QS.get('h') ?? sel.value.h));
  for (const [zone, key] of [['exterior', 'ext'], ['interior', 'int']]) {
    const v = QS.get(key);
    if (v && HEX.test(v)) setColor(zone, v);
  }
  if (QS.get('ao') === '0') ao.value = false;
  if (QS.has('explode')) explode.value = Math.min(1, Math.max(0, parseFloat(QS.get('explode')) || 0));
  const sec = QS.get('section');
  if (SECTION_MODES.some((m) => m.id === sec) && sec !== 'off') {
    await setSectionMode(sec);
    if (QS.has('cx')) cutXIn.value = parseFloat(QS.get('cx'));
    if (QS.has('cy')) cutYIn.value = parseFloat(QS.get('cy'));
    await nextTick();
  }
  const v = QS.get('view');
  viewer.value?.view(v === 'interior' ? 'interior' : v === 'section' && sectionMode.value !== 'off' ? 'section' : 'exterior');
});
</script>

<template>
  <div class="layout">
    <main class="stage">
      <WindowViewer ref="viewer" :assembly="assembly" :version="version" :selected="selectedId"
                    :controls="gridControls" :show-controls="showControls && !busy"
                    :section="sectionProp" :explode="explode" :ao="ao" :section-core-color="coreColor"
                    @select="select" @add="addWindow" />
      <div class="stage-tools" v-if="assembly">
        <button @click="viewer.view('exterior')">Exterior</button>
        <button @click="viewer.view('interior')">Interior</button>
        <button v-if="sectionMode !== 'off'" @click="viewer.view('section')">Section</button>
        <button :class="{ on: explode > 0 }" @click="explode = explode > 0 ? 0 : 1">{{ explode > 0 ? 'Assemble' : 'Explode' }}</button>
        <button :class="{ on: showControls }" @click="showControls = !showControls" title="Show the + buttons and window labels">Grid controls</button>
      </div>
      <div class="badge">Visual preview. Not a source of manufacturing dimensions. Joints between windows are not modelled.</div>
      <div v-if="loading" class="overlay">Loading…</div>
      <div v-else-if="loadError" class="overlay error">
        <h2>Could not open model</h2>
        <p>{{ loadError.message }}</p>
        <ul v-if="loadError.errors.length">
          <li v-for="(e, i) in loadError.errors.slice(0, 40)" :key="i">{{ e }}</li>
          <li v-if="loadError.errors.length > 40">… {{ loadError.errors.length - 40 }} more</li>
        </ul>
      </div>
    </main>

    <aside class="panel">
      <header>
        <h1>Window configurator</h1>
        <p class="muted" v-if="assembly">
          {{ units.length }} window{{ units.length === 1 ? '' : 's' }} · overall {{ fmtIn(ext.w) }} × {{ fmtIn(ext.h) }} in
        </p>
        <p class="muted small" v-if="units.length > 1">
          Overall size is the extent of the frame outside sizes, butted frame to frame. Mullions and couplers are not
          modelled, so this is not a mulled-unit or order dimension.
        </p>
        <label class="file-btn">Load GLB…<input type="file" accept=".glb" @change="onFile" /></label>
      </header>

      <fieldset :disabled="!assembly || busy">
        <legend>Windows</legend>
        <div class="win-tabs">
          <button v-for="w in units" :key="w.id" :class="{ on: w.id === selectedId }" :title="w.type" @click="select(w.id)">{{ w.label }}</button>
        </div>
        <div class="field" v-if="selSides">
          <label>Add a window next to {{ selLabel }}</label>
          <div class="add-pad">
            <button v-for="s in ['top', 'left', 'right', 'bottom']" :key="s" :class="`pad-${s}`" :disabled="!selSides[s].ok"
                    :title="selSides[s].ok ? `Add a window ${s === 'top' ? 'above' : s === 'bottom' ? 'below' : `to the ${s} of`} ${selLabel}` : selSides[s].reason"
                    @click="addWindow({ id: selectedId, side: s })">{{ SIDE_LABEL[s] }}</button>
            <span class="pad-mid">{{ selLabel }}</span>
          </div>
          <p class="muted small">A new window copies {{ selLabel }}'s type, size and colours. Then you can change it. You can also use the + buttons in the view.</p>
        </div>
        <button class="link danger" :disabled="!removeCheck.ok" :title="removeCheck.reason" @click="removeSelected">Remove {{ selLabel }}</button>
        <p v-if="sel && !removeCheck.ok && removeCheck.reason" class="muted small">{{ removeCheck.reason }}.</p>
        <p v-if="busy" class="muted small">Working…</p>
        <div v-if="typeError" class="err">
          {{ typeError.message }}
          <ul v-if="typeError.errors.length" class="small"><li v-for="(e, i) in typeError.errors.slice(0, 12)" :key="i">{{ e }}</li></ul>
        </div>
      </fieldset>

      <fieldset :disabled="!sel || busy">
        <legend>{{ selLabel }} · type</legend>
        <select :value="sel?.type.key" @change="changeType($event.target.value)">
          <option v-for="t in types" :key="t.key" :value="t.key">{{ t.label }}</option>
        </select>
        <p class="muted small" v-if="windowType">{{ windowType }}. Changing the type keeps the window's place, size and colours.</p>
      </fieldset>

      <fieldset :disabled="!sel || busy">
        <legend>{{ selLabel }} · size</legend>
        <div class="field">
          <label for="w">Width (frame outside)</label>
          <div class="row">
            <input id="w" class="num" type="number" :step="IN_STEP" v-model="widthText" @change="commitText" @keyup.enter="commitText" />
            <span class="unit">in</span><span class="muted">{{ sel ? fmtMm(sel.w) : '' }} mm</span>
          </div>
          <input type="range" :min="limits.minW" :max="limits.maxW" :step="IN_STEP" :value="sel?.w ?? 0"
                 @input="setSize(+$event.target.value, sel.h)" />
        </div>
        <div class="field">
          <label for="h">Height (frame outside)</label>
          <div class="row">
            <input id="h" class="num" type="number" :step="IN_STEP" v-model="heightText" @change="commitText" @keyup.enter="commitText" />
            <span class="unit">in</span><span class="muted">{{ sel ? fmtMm(sel.h) : '' }} mm</span>
          </div>
          <input type="range" :min="limits.minH" :max="limits.maxH" :step="IN_STEP" :value="sel?.h ?? 0"
                 @input="setSize(sel.w, +$event.target.value)" />
        </div>
        <p v-if="sizeError" class="err">{{ sizeError }}</p>
        <p v-if="hardwareWarning" class="muted small">⚠ {{ hardwareWarning }}</p>
        <p v-if="units.length > 1" class="muted small">Windows attached to the right of or above {{ selLabel }} move with it. A size that would make windows overlap is blocked.</p>
        <button class="link" @click="resetSize">Reset to {{ refSizeIn.w }} × {{ refSizeIn.h }} in</button>
      </fieldset>

      <fieldset :disabled="!sel || busy">
        <legend>{{ selLabel }} · colour</legend>
        <div v-for="zone in zones" :key="zone" class="field">
          <label>{{ zone === 'exterior' ? 'Exterior' : 'Interior' }}</label>
          <div class="swatches">
            <button v-for="s in PREVIEW_SWATCHES" :key="s.hex" class="swatch" :title="s.name"
                    :class="{ on: sel?.colors[zone]?.toLowerCase() === s.hex }" :style="{ background: s.hex }"
                    @click="setColor(zone, s.hex)"></button>
            <input type="color" :value="sel?.colors[zone]" @input="setColor(zone, $event.target.value)" title="Custom colour" />
          </div>
        </div>
        <p v-if="selModel && !selModel.hasFaceSplit" class="muted small">
          This GLB has no exterior/interior face split (Part B), so colours apply per part.
        </p>
      </fieldset>

      <fieldset :disabled="!sel">
        <legend>Animation</legend>
        <div class="row wrap">
          <span class="muted small">{{ selLabel }}:</span>
          <button v-for="c in selModel?.clips || []" :key="c.clip.name" @click="play(c.clip.name)">{{ c.label }}</button>
          <button v-if="(selModel?.clips.filter((c) => c.direction !== 'close').length ?? 0) > 1" @click="play(null)">Both</button>
          <button @click="closeSelected">Close</button>
        </div>
        <div class="row wrap" v-if="units.length > 1">
          <span class="muted small">All windows:</span>
          <button @click="playAll">Open all</button>
          <button @click="closeAll">Close all</button>
        </div>
        <p v-if="selModel?.clips.some((c) => c.motion !== 'translate')" class="muted small">
          Opening angle {{ selModel.clips.find((c) => c.motion !== 'translate').cfg.openAngle_deg }}° is a preview value, not product data.
        </p>
        <div class="row wrap">
          <button :disabled="!playing" @click="togglePause">{{ paused ? 'Resume' : 'Pause' }}</button>
          <label class="inline"><input type="checkbox" v-model="loop" /> Loop</label>
          <label class="inline">Speed
            <select v-model.number="speed"><option :value="0.5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option><option :value="4">4×</option></select>
          </label>
        </div>
      </fieldset>

      <fieldset :disabled="!assembly">
        <legend>View</legend>
        <div class="field">
          <label for="ex">Exploded view</label>
          <div class="row">
            <input id="ex" type="range" min="0" max="1" step="0.01" v-model.number="explode" />
            <span class="muted pct">{{ Math.round(explode * 100) }}%</span>
          </div>
        </div>
        <div class="field">
          <label>Cross-section</label>
          <div class="seg">
            <button v-for="m in SECTION_MODES" :key="m.id" :title="m.title" :class="{ on: sectionMode === m.id }"
                    @click="setSectionMode(m.id)">{{ m.label }}</button>
          </div>
        </div>
        <div v-if="sectionMode === 'corner' || sectionMode === 'vertical'" class="field">
          <label for="cx">Cut from left: {{ cutXIn.toFixed(2) }} in</label>
          <input id="cx" type="range" min="0.25" :max="ext.w - 0.25" step="0.125" v-model.number="cutXIn" />
        </div>
        <div v-if="sectionMode === 'corner' || sectionMode === 'horizontal'" class="field">
          <label for="cy">Cut from bottom: {{ cutYIn.toFixed(2) }} in</label>
          <input id="cy" type="range" min="0.25" :max="ext.h - 0.25" step="0.125" v-model.number="cutYIn" />
        </div>
        <label class="inline"><input type="checkbox" v-model="ao" /> Ambient occlusion</label>
        <p v-if="ao && sectionMode !== 'off'" class="muted small">Ambient occlusion is paused while a section is shown.</p>
      </fieldset>

      <fieldset :disabled="!sel">
        <legend>
          <button class="link" @click="showParts = !showParts">{{ showParts ? '▾' : '▸' }} {{ selLabel }} parts ({{ parts.length }})</button>
        </legend>
        <table v-if="showParts" class="parts">
          <thead><tr><th>Part</th><th>X</th><th>Y</th><th>Zone</th></tr></thead>
          <tbody>
            <tr v-for="p in parts" :key="p.name">
              <td :title="`${p.assembly} / ${p.side} / ${p.role}`">{{ p.name }}</td>
              <td>{{ p.canScaleX ? '↔' : '·' }}</td>
              <td>{{ p.canScaleY ? '↕' : '·' }}</td>
              <td>{{ p.colorZone }}</td>
            </tr>
          </tbody>
        </table>
      </fieldset>
    </aside>
  </div>
</template>
