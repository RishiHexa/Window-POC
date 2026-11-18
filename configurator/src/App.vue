<script setup>
import { ref, shallowRef, markRaw, computed, watch, onMounted, nextTick } from 'vue';
import WindowViewer from './components/WindowViewer.vue';
import { loadGltf, WindowModel, ConfigError } from './configurator/WindowModel.js';
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
// GLBs shipped in ./public for the model picker (any other GLB: ?model= or "Load GLB…").
const BUNDLED_MODELS = [
  { file: 'Window_V3_cfg.glb', label: 'Double-hung (Window_V3)' },
  { file: 'Casement_V4_cfg.glb', label: 'Casement (Casement_V4)' },
];
// --------------------------------------------------------------------------------

// Optional URL params for sharing a preview: ?model=&w=&h=&ext=&int=&view=interior
const QS = new URLSearchParams(location.search);
const DEFAULT_MODEL = QS.get('model') || 'Window_V3_cfg.glb';
const HEX = /^#[0-9a-f]{6}$/i;

const viewer = ref(null);
const model = shallowRef(null);
const sourceName = ref('');
const loadError = ref(null);   // { message, errors[] }
const loading = ref(false);

const widthIn = ref(24);
const heightIn = ref(36);
const widthText = ref('24');
const heightText = ref('36');
const sizeError = ref('');
const colors = ref({ exterior: '#ffffff', interior: '#ffffff' });

const playing = ref(false);
const paused = ref(false);
const loop = ref(false);
const speed = ref(1);
const parts = ref([]);
const showParts = ref(false);

// ---- presentation: explode / section / AO ----
const explode = ref(0);
const ao = ref(true);
const sectionMode = ref('off'); // off | corner | vertical | horizontal
const cutXIn = ref(4.5);
const cutYIn = ref(4.5);
const SECTION_MODES = [
  { id: 'off', label: 'Off' },
  { id: 'corner', label: 'Corner' },
  { id: 'vertical', label: 'Vertical', title: 'Vertical cut: head, meeting rail and sill profiles' },
  { id: 'horizontal', label: 'Horizontal', title: 'Horizontal cut: jamb and stile profiles' },
];
const sectionProp = computed(() => ({ mode: sectionMode.value, x_m: inToM(cutXIn.value), y_m: inToM(cutYIn.value) }));
const coreColor = computed(() => model.value?.initialColors.exterior ?? model.value?.initialColors.interior ?? null);
async function setSectionMode(mode) {
  // Starting positions when entering a mode (presentation only).
  if (mode === 'corner') { cutXIn.value = 4.5; cutYIn.value = 4.5; }
  if (mode === 'vertical') cutXIn.value = widthIn.value / 2;
  if (mode === 'horizontal') cutYIn.value = heightIn.value / 4; // a stile, away from the meeting rail
  sectionMode.value = mode;
  await nextTick();
  viewer.value?.view(mode === 'off' ? 'exterior' : 'section');
}

const limits = computed(() => {
  const m = model.value;
  if (!m) return { minW: 1, minH: 1, maxW: VISUAL_MAX_IN.width, maxH: VISUAL_MAX_IN.height };
  // Round the geometric collapse limit UP to the next input step, so it is never crossed.
  const up = (v) => Math.ceil(v / IN_STEP) * IN_STEP + IN_STEP;
  return {
    minW: up(mToIn(m.limits.minWidth_m)),
    minH: up(mToIn(m.limits.minHeight_m)),
    maxW: VISUAL_MAX_IN.width,
    maxH: VISUAL_MAX_IN.height,
  };
});
// Fixed-size hinge hardware (Casement_V3+) extends past the frame below this size. Warning only: the
// hinge maker's real size range is not in the GLB data, so nothing is blocked on it.
const hardwareWarning = computed(() => {
  const L = model.value?.limits;
  if (!L) return '';
  const over = [];
  if (L.hardwareFitWidth_m != null && inToM(widthIn.value) < L.hardwareFitWidth_m) over.push(`width < ${mToIn(L.hardwareFitWidth_m).toFixed(2)} in`);
  if (L.hardwareFitHeight_m != null && inToM(heightIn.value) < L.hardwareFitHeight_m) over.push(`height < ${mToIn(L.hardwareFitHeight_m).toFixed(2)} in`);
  return over.length ? `At ${over.join(' and ')}, the preview's fixed-size hinge hardware extends past the frame. The hinge's real size range is not in the GLB data.` : '';
});
const windowType = computed(() => model.value?.rootCfg.windowType ?? null);
const selectedBundled = computed(() => (BUNDLED_MODELS.some((m) => m.file === sourceName.value) ? sourceName.value : ''));
function pickBundled(file) {
  if (!file || file === sourceName.value) return;
  closeSashes();
  open(`./${file}`, file);
}
const refSizeIn = computed(() => model.value
  ? { w: model.value.rootCfg.reference.width_in ?? mToIn(model.value.ref.width_m), h: model.value.rootCfg.reference.height_in ?? mToIn(model.value.ref.height_m) }
  : { w: 24, h: 36 });
const fmtMm = (inch) => (inch * 25.4).toFixed(1);

async function open(source, name) {
  loading.value = true;
  loadError.value = null;
  try {
    const buf = source instanceof ArrayBuffer ? source : await fetchGlb(source);
    const gltf = await loadGltf(buf);
    const m = markRaw(new WindowModel(gltf));
    model.value?.dispose();
    model.value = m;
    sourceName.value = name;
    parts.value = m.describeParts();
    colors.value = { exterior: m.initialColors.exterior ?? '#ffffff', interior: m.initialColors.interior ?? '#ffffff' };
    setSize(refSizeIn.value.w, refSizeIn.value.h);
    m.mixer.addEventListener('finished', () => {
      if (m.clips.every((c) => !c.action.isRunning())) playing.value = false;
    });
    playing.value = false;
    paused.value = false;
  } catch (e) {
    loadError.value = e instanceof ConfigError
      ? { message: `${name}: ${e.message}`, errors: e.errors }
      : { message: `${name}: ${e.message}`, errors: [] };
  } finally {
    loading.value = false;
  }
}

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

function onFile(ev) {
  const f = ev.target.files?.[0];
  if (!f) return;
  f.arrayBuffer().then((buf) => open(buf, f.name));
  ev.target.value = '';
}

// ---- size ----
function setSize(w, h) {
  const L = limits.value;
  const problems = [];
  if (!Number.isFinite(w) || w < L.minW || w > L.maxW) problems.push(`width must be ${L.minW}–${L.maxW} in`);
  if (!Number.isFinite(h) || h < L.minH || h > L.maxH) problems.push(`height must be ${L.minH}–${L.maxH} in`);
  if (problems.length) { sizeError.value = problems.join('; '); return; } // block, never auto-clamp
  sizeError.value = '';
  widthIn.value = w; heightIn.value = h;
  widthText.value = String(w); heightText.value = String(h);
  model.value?.setSize(inToM(w), inToM(h));
  viewer.value?.recenter();
}
const commitText = () => setSize(parseFloat(widthText.value), parseFloat(heightText.value));
const resetSize = () => setSize(refSizeIn.value.w, refSizeIn.value.h);

// ---- colours ----
watch(colors, (c) => {
  if (!model.value) return;
  model.value.setZoneColor('exterior', c.exterior);
  model.value.setZoneColor('interior', c.interior);
  viewer.value?.invalidate(false);
}, { deep: true });

// ---- animation ----
function play(clip) {
  model.value?.play(clip, { loop: loop.value, timeScale: speed.value });
  playing.value = true; paused.value = false;
}
function togglePause() { paused.value = !paused.value; model.value?.setPaused(paused.value); }
function closeSashes() { model.value?.stop(); playing.value = false; paused.value = false; viewer.value?.invalidate(true); }
watch(speed, (s) => model.value?.setTimeScale(s));

onMounted(async () => {
  await open(`./${DEFAULT_MODEL}`, DEFAULT_MODEL);
  if (!model.value) return;
  if (QS.has('w') || QS.has('h')) setSize(parseFloat(QS.get('w') ?? widthIn.value), parseFloat(QS.get('h') ?? heightIn.value));
  for (const [zone, key] of [['exterior', 'ext'], ['interior', 'int']]) {
    const v = QS.get(key);
    if (v && HEX.test(v)) colors.value[zone] = v;
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
      <WindowViewer ref="viewer" :model="model" :section="sectionProp" :explode="explode" :ao="ao"
                    :section-core-color="coreColor" />
      <div class="stage-tools" v-if="model">
        <button @click="viewer.view('exterior')">Exterior</button>
        <button @click="viewer.view('interior')">Interior</button>
        <button v-if="sectionMode !== 'off'" @click="viewer.view('section')">Section</button>
        <button :class="{ on: explode > 0 }" @click="explode = explode > 0 ? 0 : 1">{{ explode > 0 ? 'Assemble' : 'Explode' }}</button>
      </div>
      <div class="badge">Visual preview. Not a source of manufacturing dimensions.</div>
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
        <p class="muted">{{ sourceName || 'No model' }}<span v-if="windowType"> · {{ windowType }}</span></p>
        <div class="row wrap">
          <select :value="selectedBundled" :disabled="loading" @change="pickBundled($event.target.value)" title="GLBs in ./public">
            <option value="" disabled>Bundled model…</option>
            <option v-for="b in BUNDLED_MODELS" :key="b.file" :value="b.file">{{ b.label }}</option>
          </select>
          <label class="file-btn">Load GLB…<input type="file" accept=".glb" @change="onFile" /></label>
        </div>
      </header>

      <fieldset :disabled="!model">
        <legend>Size</legend>
        <div class="field">
          <label for="w">Width (frame outside)</label>
          <div class="row">
            <input id="w" class="num" type="number" :step="IN_STEP" v-model="widthText" @change="commitText" @keyup.enter="commitText" />
            <span class="unit">in</span><span class="muted">{{ fmtMm(widthIn) }} mm</span>
          </div>
          <input type="range" :min="limits.minW" :max="limits.maxW" :step="IN_STEP" :value="widthIn"
                 @input="setSize(+$event.target.value, heightIn)" />
        </div>
        <div class="field">
          <label for="h">Height (frame outside)</label>
          <div class="row">
            <input id="h" class="num" type="number" :step="IN_STEP" v-model="heightText" @change="commitText" @keyup.enter="commitText" />
            <span class="unit">in</span><span class="muted">{{ fmtMm(heightIn) }} mm</span>
          </div>
          <input type="range" :min="limits.minH" :max="limits.maxH" :step="IN_STEP" :value="heightIn"
                 @input="setSize(widthIn, +$event.target.value)" />
        </div>
        <p v-if="sizeError" class="err">{{ sizeError }}</p>
        <p v-if="hardwareWarning" class="muted small">⚠ {{ hardwareWarning }}</p>
        <button class="link" @click="resetSize">Reset to {{ refSizeIn.w }} × {{ refSizeIn.h }} in</button>
      </fieldset>

      <fieldset :disabled="!model">
        <legend>Colour</legend>
        <div v-for="zone in ['exterior', 'interior']" :key="zone" class="field">
          <label>{{ zone === 'exterior' ? 'Exterior' : 'Interior' }}</label>
          <div class="swatches">
            <button v-for="s in PREVIEW_SWATCHES" :key="s.hex" class="swatch" :title="s.name"
                    :class="{ on: colors[zone].toLowerCase() === s.hex }" :style="{ background: s.hex }"
                    @click="colors[zone] = s.hex"></button>
            <input type="color" v-model="colors[zone]" title="Custom colour" />
          </div>
        </div>
        <p v-if="model && !model.hasFaceSplit" class="muted small">
          This GLB has no exterior/interior face split (Part B), so colours apply per part.
        </p>
      </fieldset>

      <fieldset :disabled="!model">
        <legend>Animation</legend>
        <div class="row wrap">
          <button v-for="c in model?.clips || []" :key="c.clip.name" @click="play(c.clip.name)">{{ c.label }}</button>
          <button v-if="(model?.clips.filter((c) => c.direction !== 'close').length ?? 0) > 1" @click="play(null)">Both</button>
        </div>
        <p v-if="model?.clips.some((c) => c.motion !== 'translate')" class="muted small">
          Opening angle {{ model.clips.find((c) => c.motion !== 'translate').cfg.openAngle_deg }}° is a preview value, not product data.
        </p>
        <div class="row wrap">
          <button :disabled="!playing" @click="togglePause">{{ paused ? 'Resume' : 'Pause' }}</button>
          <button @click="closeSashes">Close</button>
          <label class="inline"><input type="checkbox" v-model="loop" /> Loop</label>
          <label class="inline">Speed
            <select v-model.number="speed"><option :value="0.5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option><option :value="4">4×</option></select>
          </label>
        </div>
      </fieldset>

      <fieldset :disabled="!model">
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
          <input id="cx" type="range" min="0.25" :max="widthIn - 0.25" step="0.125" v-model.number="cutXIn" />
        </div>
        <div v-if="sectionMode === 'corner' || sectionMode === 'horizontal'" class="field">
          <label for="cy">Cut from bottom: {{ cutYIn.toFixed(2) }} in</label>
          <input id="cy" type="range" min="0.25" :max="heightIn - 0.25" step="0.125" v-model.number="cutYIn" />
        </div>
        <label class="inline"><input type="checkbox" v-model="ao" /> Ambient occlusion</label>
        <p v-if="ao && sectionMode !== 'off'" class="muted small">Ambient occlusion is paused while a section is shown.</p>
      </fieldset>

      <fieldset :disabled="!model">
        <legend>
          <button class="link" @click="showParts = !showParts">{{ showParts ? '▾' : '▸' }} Parts ({{ parts.length }})</button>
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
