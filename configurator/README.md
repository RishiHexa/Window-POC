# Window configurator (POC)

Vue 3 + Three.js viewer for `configurator/public/Window_V3_cfg.glb` (double-hung) and `configurator/public/Casement_V4_cfg.glb` (casement). It changes width, height, exterior and interior colour, and plays the sash animations. Everything is driven by the `extras.cfg` userData described in [../prompts/01-glb-userdata-prompt.md](../prompts/01-glb-userdata-prompt.md) and, for the casement hinge, [../prompts/02-casement-glb-prompt.md](../prompts/02-casement-glb-prompt.md).

**This is a visual preview only.** Geometry here is never a source of manufacturing dimensions, cut lengths or BOM data.

```bash
npm install
npm run dev            # http://localhost:5173, loads /Window_V3_cfg.glb from ./public
npm run validate       # validate public/Window_V3_cfg.glb (schema, split planes, additive-only vs ../glb/Window_V3.glb)
npm run test:deform    # headless WindowModel checks (joints, mitre rigidity, reset, animation travel, colours)
npm run validate:casement   # validate public/Casement_V4_cfg.glb (additive-only vs ../glb/Casement_V4.glb)
npm run test:casement  # headless casement checks (hinge pivots, 90° swing, shoe slide, linkage closure, resize while open)
node tools/test-governor.mjs   # adaptive-quality (60 fps) logic
```

- Switch between the bundled GLBs with the **Bundled model…** picker (`BUNDLED_MODELS` in `src/App.vue`).
- Other files: `?model=Casement_V4_cfg.glb`, or the **Load GLB…** button.
- Share a state: `?w=48&h=60&ext=%234e3c2c&int=%23f2f2ee&view=interior`
  - also `&explode=1`, `&section=corner|vertical|horizontal&cx=4.5&cy=4.5&view=section`, and `&ao=0`
- Serve GLBs from another folder: `GLB_DIR=<folder> npm run dev`

## How resizing works

Each part's cfg defines a split plane per axis. Vertices below the split move by `Δ × below`, and vertices above it move by `Δ × above`. Every vertex is translated rigidly, so mitres and profile sections stay exact. The deformation is always recomputed from the original reference positions, so edits never drift.

- Sash travel animations are scaled by `(referenceTravel_m + travelPerDeltaHeight × ΔH) / referenceTravel_m`.
- Size inputs are blocked (not clamped) below the geometric collapse limit, which is computed from the vertices.
- The slider maximums (`VISUAL_MAX_IN`) and the colour swatches (`PREVIEW_SWATCHES`) in `src/App.vue` are POC placeholders, **not product data**.

## Casement (hinged sash)

The casement GLB adds `davinci.window.hinge/1` pivot/offset node pairs and a root animation with `motion: "rotate"` or `"rotate+slide"`. Both are additive: an animation entry without `motion` still means translate, and the double-hung behaves exactly as before.

- **Hinge nodes.** A pivot node holds P. Its child offset node holds −P, so the meshes below keep absolute reference coordinates. On load, the pair must cancel exactly and P must equal `cfg.pivot_m`. Otherwise the GLB is rejected.
- **Resize.** Each pivot moves to `P + (ΔW × pivotFactor.x, ΔH × pivotFactor.y, 0)` and its offset moves to the negation. The clip's translation keys (absolute pivot path) get the same shift. They are **not scaled**, because the opening angle and the hinge's shoe slide are fixed hardware values.
- **Resize while open.** Hinge actions are stopped and then resumed at the same time. That way **Close** returns to the new rest pose instead of the one saved when the clip started.
- **Closing animation (Casement_V4+).** A root animation with `direction: "close"` is named by the hinge pivot's `cfg.closeClip`. Its rest pose is the last key, and it may drive the same pivots as its open clip. In the panel it appears as **Sash (close)**.
  - Open and close stop each other.
  - On load, the close clip is checked to be the open clip's exact time-reverse. When that holds, switching mid-swing continues from the mirrored time, so the sash doesn't jump. If it doesn't hold, the new clip starts from its beginning.
  - Closing a sash that is already closed does nothing.
  - **Both** plays opening clips only.
  - The **Close** button still snaps straight to rest.
- **Hardware** (`role: "hardware"`, the Truth #14.97 track and arms in Casement_V3/V4) is rigid and keeps its own `Hardware_Metal` material. It is never recoloured, and it gets its own section cap. Below the width where the fixed-size track would extend past the frame (13.67 in for Casement_V3/V4), the panel shows a **warning only**. The hinge's real size range is not in the GLB data, so nothing is blocked on it.
- The 90° opening angle is a preview value, not product data (root cfg `openAngle_source`).

## View features

- **Exploded view:** the slider or the Explode button eases parts apart along their stack-up (`src/configurator/explode.js`). It moves transforms only. Geometry is untouched, and 0 % restores the exact identity transforms.
- **Cross-section:** Corner (an L cut like a profile sample), Vertical (head, meeting rail and sill), or Horizontal (jambs). The cut is made with clipping planes and filled with stencil caps (`SectionCaps.js`), so chambers show as solid PVC.
  - Cut faces use the PVC core colour, so a coloured exterior reads like a laminate over a white core.
  - The caps need closed, consistently wound solids. All 38 parts of Window_V3_cfg.glb were checked.

## Performance (target 60 fps)

- **On-demand rendering:** frames are drawn only while something changes (orbit, damping, sash animation, explode easing, edits). An idle view uses no GPU.
- **Shadows:** the shadow map redraws only when geometry or transforms change, not on camera moves.
- **Glass:** uses the GLB's own alpha blend. There is no transmission pass, which was a second full-scene render per frame.
- **Adaptive quality:** `FrameGovernor` measures consecutive rendered frames. If a 40-frame window averages under ~54 fps, it drops one level (High → Medium → Low → Lowest: pixel ratio 2 → 1.5 → 1.25 → 1, AO off from Low, MSAA 4 → 2). It retries one level up after ~900 good frames, and locks a level that fails within 5 windows of an upgrade.
- **Readout:** the bottom-right overlay shows `fps · quality` (or `idle`).

## Files

| file | role |
|---|---|
| `src/configurator/schema.js` | cfg contract and validation (shared with the Node tools) |
| `src/configurator/deform.js` | split-plane maths (pure, no three.js) |
| `src/configurator/WindowModel.js` | loads the GLB, validates it, applies size, colours and animation |
| `src/configurator/explode.js` | exploded-view layout (presentation only) |
| `src/configurator/SectionCaps.js` | section clipping and stencil caps |
| `src/configurator/FrameGovernor.js` | adaptive quality for 60 fps |
| `src/components/WindowViewer.vue` | renderer, post-processing, camera, on-demand loop |
| `src/App.vue` | configuration panel |
| `tools/validate-glb.mjs` | CLI validator for the GLB produced by the prompt |
| `tools/test-deform.mjs` | headless model tests (double-hung) |
| `tools/test-casement.mjs` | headless model tests (casement: hinge, linkage, resize while open) |
| `tools/test-governor.mjs` | governor unit tests |
