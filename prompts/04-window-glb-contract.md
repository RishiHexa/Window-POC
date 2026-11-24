# Window GLB contract: what a GLB must contain for the configurator

This is a reference for any agent that builds a window GLB for `configurator/`. It lists everything the configurator reads: geometry rules, hierarchy, `extras.cfg` userData, materials and animations. It also explains the logic that consumes each value.

The source of truth is the code. If this file and the code disagree, the code wins. Report the mismatch.

- `configurator/src/configurator/schema.js`: the cfg contract and its validation
- `WindowModel.js`: loading, resize, colours, animation
- `deform.js`: split-plane maths
- `explode.js`, `WindowAssembly.js`: exploded view, multi-window depth alignment
- `tools/validate-glb.mjs`: the CLI validator

Worked examples are `prompts/01-glb-userdata-prompt.md` (double-hung, `Window_V3_cfg.glb`) and `prompts/03-casement-glb-one-shot-prompt.md` (casement, `Casement_V4_cfg.glb`).

**The GLB is a visual preview only.** Nothing in it is a source of manufacturing dimensions, cut lengths, BOM or pricing. Even so, every dimension must come from a drawing or a documented input. Never invent a value. If data is missing or contradictory, stop and report. Do not guess.

---

## 0. What the configurator can drive today

| window type | supported | how |
|---|---|---|
| Fixed (no moving sash) | yes | root `animations: []` |
| Vertical sliding (single- or double-hung) | yes | `motionGroup` node + root animation `motion: "translate"`, `axis: "y"` |
| Casement (hinge axis vertical) | yes | hinge pivot/offset nodes with `axis: "y"`, `hingeSide: "left"`/`"right"` + root animation `motion: "rotate"` or `"rotate+slide"` |
| Awning (hinged at the head) / hopper (hinged at the sill) | yes (since 2026-11-24) | the same hinge nodes with `axis: "x"`, `hingeSide: "top"`/`"bottom"`. See §8. Tested only with a synthetic model so far (`npm run test:awning`) |
| Horizontal slider | **no, needs a configurator change first** | travel only scales with height (`travelPerDeltaHeight`). There is no width term, so the travel would be wrong when the width changes |
| Mullions, couplers, mulled units | **no** | no documented data. The configurator butts separate windows frame to frame |

If the new GLB is of an unsupported type, stop and report. Do not bend the existing fields to fit it. Support is added additively in `schema.js` first, as a new optional field or a new `motion` value.

---

## 1. File-level rules

1. **Format.** Binary glTF 2.0 (`.glb`), one scene.
2. **Units.** Metres. 1 in = 0.0254 m exactly.
3. **No compression or quantization.** POSITION must be a plain `FLOAT` (float32) VEC3, not normalized. No Draco, no meshopt, no `KHR_mesh_quantization`. The loader has no decoders and rejects quantized positions. Interleaved buffers are accepted.
4. **Primitives.** Mode 4 (triangles) only. Indices are UNSIGNED_SHORT or UNSIGNED_INT. Flat normals are fine. UVs are not needed: surface detail is projected triplanar.
5. **No mesh sharing between nodes.** Each part node owns its mesh. The loader clones geometry anyway, but the validator and the additive checks assume one mesh per node.
6. **Allowed extensions.** `KHR_materials_clearcoat`, `KHR_materials_transmission` and `KHR_materials_ior` are used by the existing files. Anything else needs a check that three.js r171 `GLTFLoader` supports it.
7. **Write `cfg` programmatically.** Use Node `@gltf-transform/core` + `@gltf-transform/extensions`, or a raw rewrite of the JSON chunk. **Never round-trip through Blender.** It turns booleans into 0/1, and can reorder data or change its precision.
8. **Additive only.** When you add cfg to an existing GLB, merge it under `extras.cfg`. Never replace `extras`. Do not change vertices, indices, node names, the hierarchy, transforms, animation samplers or existing extras keys. Keep the no-cfg file as `<name>.glb` and write the configured one as `<name>_cfg.glb`, so the validator can compare them with `--original`.
9. **Strict JSON types.** Booleans are JSON `true`/`false`. Numbers are JSON numbers, never strings.

---

## 2. Coordinate system and geometry

These rules are relied on by resize, multi-window placement, the wall opening and section cuts.

- **Y-up.** Width = **X**, height = **Y**, depth = **Z**.
- **Origin** = the bottom-left **outside corner of the frame**, on the frame's **exterior face**.
  - The frame outside rectangle spans exactly x 0 → W0 and y 0 → H0. W0 and H0 are the reference size in the root cfg.
  - The multi-window layout and the scenery wall opening use this rectangle directly. If the frame does not start at (0, 0), the windows overlap or leave gaps.
- **Exterior faces +Z.** The frame exterior face is at z = 0, and the interior goes toward −Z. Use max z = 0 within 1e-6.
- **Bake geometry in absolute reference coordinates.** Every node has an identity transform, except the animated nodes in §3. The resize code works on node-local vertex positions and assumes they are the absolute coordinates.
- **45° mitres are expected at corners.** Resize translates vertices rigidly, so mitres stay exact. Never use node scale for size.
- **Closed, consistently wound solids** for every mesh, with chambers as holes. The section-cut caps use the stencil buffer and render garbage on open or flipped meshes. Check this by merging vertices by position: every edge must be shared by exactly 2 triangles, with opposite orientation.

---

## 3. Hierarchy and transforms

```
Scene
└─ <Root node>                        extras.cfg.schema = "davinci.window.cfg/1"  (exactly one)
   ├─ <part mesh nodes>               "davinci.window.part/1"   identity transform
   ├─ <motion group>  (sliding sash)  "davinci.window.group/1"  translation animated
   │   └─ <part mesh nodes>
   └─ <hinge pivot>  (casement)       "davinci.window.hinge/1"  role hingePivot / linkPivot, T = P
       └─ <hinge offset>              "davinci.window.hinge/1"  role hingeOffset / linkOffset, T = −P
           └─ <part mesh nodes>
```

Rules:

- **Every node has `extras.cfg`.** The validator errors on any node without it. At runtime, every mesh must have a `davinci.window.part/1` node on itself or on an ancestor.
- **A mesh node always uses `davinci.window.part/1`.** A part cfg on a node without a mesh is an error.
- **Exactly one root cfg node.**
- **Transforms are identity everywhere, except:**
  - `motionGroup` nodes. Their animated translation must be `[0, 0, 0]` at rest. See §7.
  - Hinge pivot and offset nodes. These carry **translation only**: no `rotation`, `scale` or `matrix` key in the JSON, not even an identity one.
- **Explicit identity keys.** Avoid writing explicit `translation`/`rotation`/`scale` keys on other nodes. The validator warns about them, and the runtime errors if they are not identity.
- **Node names.** Use DWG block codes and hardware part numbers, never invented codes. three.js sanitizes names (`.` is removed: `Hinge_Top_SashArm_14.97` → `Hinge_Top_SashArm_1497`). Every name that a cfg string refers to (`offsetNode`, `pivotNode`, `node`) must be written exactly as the glTF node name.

---

## 4. Root cfg (`davinci.window.cfg/1`)

On the root node. Example from Casement_V4:

```json
{
  "schema": "davinci.window.cfg/1",
  "units": "m",
  "windowType": "casement",
  "reference": { "width_m": 0.6096, "height_m": 0.9144, "width_in": 24, "height_in": 36 },
  "axes": { "width": "x", "height": "y", "depth": "z", "exteriorFacing": "+z" },
  "colorZones": ["exterior", "interior"],
  "animations": [ ... see §7 / §8 ... ]
}
```

| field | required | used for |
|---|---|---|
| `schema` | yes | must be `"davinci.window.cfg/1"` |
| `units` | yes | must be `"m"` |
| `reference.width_m`, `reference.height_m` | yes, > 0 | W0/H0. ΔW = W − W0 and ΔH = H − H0 drive all deformation. This is the frame outside size of the modelled unit |
| `reference.width_in`, `reference.height_in` | recommended | the panel's reference size in inches. Falls back to m ÷ 0.0254 |
| `animations` | yes (array; may be empty) | §7 / §8 |
| `windowType` | recommended | shown in the panel (`"double-hung"`, `"casement"`, `"fixed"`, …) |
| `axes`, `colorZones` | recommended | documentation. Not validated |
| provenance (`window_type`, `hinge_side`, `opens`, `note`, `hinge_hardware {…}`, …) | recommended | traceability. Sits outside `cfg`, in plain `extras` |

---

## 5. Part cfg (`davinci.window.part/1`) and the resize logic

On **every mesh node**:

```json
{
  "schema": "davinci.window.part/1",
  "role": "profile",
  "assembly": "Frame",
  "side": "left",
  "canScaleX": false,
  "canScaleY": true,
  "x": { "split_m": 0.3048, "below": 0, "above": 0 },
  "y": { "split_m": 0.4572, "below": 0, "above": 1 },
  "colorZone": "exterior"
}
```

| field | values | rule |
|---|---|---|
| `role` | `profile`, `gasket`, `glass`, `hardware` | `profile` = PVC extrusion (colourable, surface detail). `gasket` = glazing tape or weatherstrip. `glass` = IGU. `hardware` = rigid metal hardware (keeps its own material, never recoloured) |
| `colorZone` | `exterior`, `interior`, `glass`, `gasket`, `hardware` | `profile` → `exterior` or `interior` only. `hardware` ⇔ `hardware` (both ways). Use `glass` for glass and `gasket` for gasket |
| `assembly` | string | used by explode (§9) and by depth alignment (`"Extension"`, optional, §9) |
| `side` | `left`, `right`, `top`, `bottom`, `infill` | explode direction. `infill` for glass |
| `x`, `y` | `{split_m, below, above}`, all numbers | split-plane stretch, below |
| `canScaleX`, `canScaleY` | JSON boolean | must equal `x.below !== x.above` (and the same for y). A contradiction is an error |

### Split-plane stretch (`deform.js`)

```
ΔW = W − W0        ΔH = H − H0
x' = x + ΔW × (x < x.split_m ? x.below : x.above)
y' = y + ΔH × (y < y.split_m ? y.below : y.above)
z' = z                                  (depth never changes)
```

- Each vertex is translated rigidly by one of two amounts, so mitres and profile sections stay exact. Only the length between the two vertex sets changes.
- `below`/`above` is the fraction of the size change that vertices on that side of the split move by.
  - Anything attached to the left/bottom outside edge moves by 0.
  - Anything attached to the right/top edge moves by 1.
  - A double-hung meeting rail moves by 0.5.
- **Stretching axis** (`below !== above`):
  - `above` must be ≥ `below`, otherwise the loader throws.
  - There must be vertices on **both** sides of the split.
  - The split must be ≥ 2 mm from every vertex (validator), and the prompts require ≥ 10 mm.
  - Put the split in a region of the part with no vertices, typically the middle of a long member.
- **Rigid axis** (`below === above`): the whole part translates by `Δ × below`. `split_m` is still required, but has no effect.
- **Hardware** must be rigid on both axes: `canScaleX` and `canScaleY` false.
- **The minimum size is computed from the vertices** (where a stretching part would invert). It is a geometric collapse limit, not a product size range. Do not put product size ranges in the GLB unless they are documented. Nothing consumes them.
- **Hardware fit is a warning only.** The panel warns below the width/height at which rigid hardware would stick out of the frame.

Typical factors (frame and sash of a 1-sash unit, splits at W0/2 and H0/2):

| member | x below/above | y below/above |
|---|---|---|
| left | 0 / 0 | 0 / 1 |
| right | 1 / 1 | 0 / 1 |
| top | 0 / 1 | 1 / 1 |
| bottom | 0 / 1 | 0 / 0 |
| glass (infill) | 0 / 1 | 0 / 1 |
| hardware at the sill / head | 0 / 0 | 0 / 0 (sill) or 1 / 1 (head) |

For a double-hung, the lower sash uses y factors 0 → 0.5 and the upper sash 0.5 → 1, with each sash's own split. See `01-glb-userdata-prompt.md`.

---

## 6. Materials and colours

- **PVC exterior/interior split (strongly recommended).** Create `PVC_Exterior` and `PVC_Interior` as exact copies of the PVC material, with `extras.cfg.colorZone` set to `"exterior"` / `"interior"`.
  - Split each profile primitive by face normal: `n.z ≥ 0.5` → exterior, `n.z ≤ −0.5` → interior. Otherwise use the node's `cfg.colorZone`.
  - Keep triangle order. Drop empty primitives. Remove the original PVC material only if nothing references it.
  - Invariants: triangle count, triangle set, POSITION bbox and vertex values are unchanged.
  - Without the split, a whole part takes one colour, and the panel says so.
- **Colour zones share one material.** Every profile primitive in a zone gets one shared material, cloned from the **first** one found. So all PVC primitives of a zone must have identical material parameters.
- **Initial colours come from the GLB.** The base colour of the zone materials is the panel's starting colour. Use the documented PVC colour.
- **Glass.** Its own material, alpha `BLEND`. The viewer does not run a transmission pass; it uses the alpha blend.
- **Gasket.** Its own material (`Glazing_Tape`). Not colourable.
- **Hardware.** Its own material (e.g. `Hardware_Metal`). Never recoloured. If its appearance is not from a drawing, tag it `"note": "preview-only …"` in the material extras.
- Copy existing materials value-for-value from `Window_V3.glb` rather than re-authoring them.

---

## 7. Sliding sash: `motionGroup` + `motion: "translate"`

**Group node** (parent of the sash's parts):

```json
{ "schema": "davinci.window.group/1", "role": "motionGroup", "assembly": "LowerSash", "clip": "LowerSash_Moving" }
```

**Root animation entry:**

```json
{ "clip": "LowerSash_Moving", "node": "LowerSash_Moving", "axis": "y",
  "referenceTravel_m": 0.347414, "travelPerDeltaHeight": 0.5, "label": "Lower sash" }
```

`motion` may be omitted, which means `"translate"`.

Logic:

- **One moving group per clip.** The runtime uses the **first** track of the clip whose name ends in `.position`. It scales only the `axis` component of every key: `key × (referenceTravel_m + travelPerDeltaHeight × ΔH) / referenceTravel_m`.
- **Keys are offsets from rest.** The group's rest translation must be `[0, 0, 0]`, and key 0 must be 0, because the scaling also multiplies the rest key.
- **Positive travel.** `referenceTravel_m` must be non-zero, and the factor must stay > 0 at every allowed height (the resize is blocked otherwise).
- **`travelPerDeltaHeight`** is how much the travel changes per metre of height change: 0.5 for a double-hung, where each sash gets half.
- **`node`** must be the node that the clip translates (validator).
- **`label`** is the button text.

---

## 8. Hinged sash (casement, awning, hopper): hinge nodes + `motion: "rotate"` / `"rotate+slide"`

| | casement | awning | hopper |
|---|---|---|---|
| hinge `axis` | `"y"` (vertical) | `"x"` (horizontal) | `"x"` (horizontal) |
| `hingeSide` | `"left"` / `"right"` (as seen from the exterior) | `"top"` | `"bottom"` |
| typical `opens` | `"outward"` | `"outward"` (bottom rail swings to +Z) | `"inward"` (top rail swings to −Z) |
| sash pivot `pivotFactor` | x = 0 left / 1 right, y = 0 | x = 0, **y = 1** (the pivot follows the head) | x = 0, y = 0 |
| root animation `axis` | `"y"` | `"x"` | `"x"` |
| slide (`rotate+slide`) | `slideAxis: "x"` (shoe slides along a head/sill track) | `slideAxis: "y"` if the shoe slides along a jamb track | `slideAxis: "y"` if the shoe slides along a jamb track |

The rotation sign comes from the right-hand rule about +X (awning, hopper) or +Y (casement). For an outward awning hinged at the head, the bottom rail moves to +Z, so the angle about +X is **negative**. Check it by the free edge's z, not by the sign of the angle (§11).

### Pivot/offset pairs (`davinci.window.hinge/1`)

A pivot node holds translation **P** (the hinge axis point) and the animated rotation, plus the translation for slider-crank hinges. Its **direct child** offset node holds **−P**. The sash meshes go below the offset, so they keep absolute reference coordinates.

**Sash pivot** (`role: "hingePivot"`):

```json
{
  "schema": "davinci.window.hinge/1", "role": "hingePivot", "assembly": "Sash",
  "clip": "Sash_Hinge", "closeClip": "Sash_Hinge_Close", "offsetNode": "Sash_HingeOffset",
  "axis": "y", "pivot_m": [0.0238074, 0, -0.0257861], "pivotFactor": { "x": 0, "y": 0 },
  "hingeSide": "left", "opens": "outward", "hingeSide_source": "<where this came from>",
  "motion": "slider-crank", "linkage": { "...": "documentation, see Casement_V4" }
}
```

**Sash offset** (`role: "hingeOffset"`):

```json
{ "schema": "davinci.window.hinge/1", "role": "hingeOffset", "assembly": "Sash", "pivotNode": "Sash_Hinge" }
```

**Link pivot/offset** (e.g. a hinge support arm rotating about a fixed stud): use `role: "linkPivot"` with `clip`, `offsetNode`, `axis`, `pivot_m` and `pivotFactor`, and `role: "linkOffset"` with `pivotNode`. `hingeSide` and `opens` are not needed.

Hard checks (load fails otherwise):

| check | tolerance |
|---|---|
| `axis` is `"y"` (casement) or `"x"` (awning / hopper) | exact |
| every rotation key of a pivot turns about that pivot's own `axis` (the other two quaternion vector components are 0). This holds for link pivots too, so an awning's linkage arms must also rotate about X | 1e-6 |
| the root animation's `axis` equals the `axis` of its `node` pivot | exact |
| the pivot's node translation equals `pivot_m` | 1e-9 |
| pivot translation + offset translation | **exactly** `[0, 0, 0]` (bitwise; write the negated numbers, do not recompute them) |
| the offset is the pivot's direct child, with `pivotNode` = the pivot's name | exact |
| no rotation/scale/matrix on hinge nodes at rest | exact |
| `hingeSide` ∈ `left`/`right` for axis y, `top`/`bottom` for axis x. `opens` ∈ `outward`/`inward` (hingePivot only) | exact |
| `motion` (if present) ∈ `rotate`/`slider-crank` | exact |
| every `clip`/`closeClip` named by a pivot is listed in the root `animations` | exact |
| every offset is named by some pivot | exact |

**`pivotFactor`** says how a pivot follows the resize: `P' = P + (ΔW × pivotFactor.x, ΔH × pivotFactor.y, 0)`, and the offset becomes −P'.

- Left-hinged: x = 0. Right-hinged: x = 1.
- y = 0 for pivots on or under the sill, 1 for ones at the head.
- The sash pivot of a vertical axis normally uses y = 0.
- For an awning, the sash pivot sits at the head, so y = 1.
- Linkage pivots on a jamb take that jamb's x factor (0 left, 1 right) and the y factor of the frame member their stud is fixed to.

### Root animation entry

```json
{ "clip": "Sash_Hinge", "node": "Sash_Hinge", "motion": "rotate+slide", "axis": "y",
  "openAngle_deg": 90, "slideAxis": "x", "slideTravel_m": 0.16510762,
  "openAngle_source": "preview-only value …; not product data", "label": "Sash" }
```

| field | rule |
|---|---|
| `motion` | `"rotate"` (pure hinge) or `"rotate+slide"` (the pivot also translates, as in a slider-crank / washability hinge) |
| `node` | the hingePivot name. The clip must have a **rotation** track on it, and for `rotate+slide` also a **translation** track |
| `openAngle_deg` | non-zero. Shown in the panel as a preview value. If it is not from a drawing, say so in `openAngle_source` |
| `slideAxis`, `slideTravel_m` | required for `rotate+slide` |
| `direction` | `"open"` (default; rest pose = first key) or `"close"` |

### Clip rules (`rotate` / `rotate+slide`)

- **Tracks.** Every track must target a hinge pivot (hingePivot or linkPivot) whose `cfg.clip` (or `closeClip`) is this clip. Only `rotation` and `translation` tracks are allowed. Nothing else is bound.
- **Rest key.** Key 0 of an open clip equals the node's rest values: identity rotation, translation = P.
- **Translation keys are the absolute pivot path at the reference size.** On resize they are **shifted** by (ΔW × pivotFactor.x, ΔH × pivotFactor.y, 0), never scaled. The opening angle and the hardware slide are fixed hardware values.
- **Keys.** LINEAR keys. The existing casement uses 31 keys over 0–3 s; the 3 s is a placeholder.
- **Close clip (optional, Casement_V4+).**
  - A separate clip with `direction: "close"` in its root entry. The hingePivot names it in `closeClip`, and its `node` is that hingePivot.
  - It may drive every pivot that its open clip drives.
  - Its **last** key is the rest pose.
  - Make it the **exact time-reverse** of the open clip: same track names, same key times, times symmetric, values reversed bit-for-bit. Only then can open↔close switch mid-swing without a jump. If it is not an exact reverse, it still loads, but restarts from its beginning.

---

## 9. Cross-feature requirements (easy to miss)

1. **Jamb extension is optional.** Use `cfg.assembly: "Extension"` on the extension parts if the drawing has one. Never add a fake one.
   - **With an extension:** windows are depth-aligned on its interior edge (the minimum z of all `"Extension"` parts). The wall's interior face is placed there.
   - **Without an extension:** the window keeps its frame exterior face at z = 0, and the wall's interior face is placed at the window's deepest geometry.
   - **The two kinds are never combined in one multi-window group.** Adding a window, or changing a window's type, so that windows with and without an extension would sit side by side is refused with a reason. There is no documented depth relation between them. A single window can be either kind.
   - The extension parts must use the exact assembly name `"Extension"`. Any other spelling counts as "no extension".
2. **Explode layout is keyed by `assembly`** (and `${assembly}_${role}` for glass/gasket).
   - Known keys: `Extension`, `Frame`, `FrameAccessory`, `LowerSash`, `UpperSash`, `LowerBead`, `UpperBead`, `Sash`, `Bead`, `Hinge`, plus `LowerSash_glass/_gasket`, `UpperSash_glass/_gasket`, `Sash_glass/_gasket`.
   - An unknown assembly is not an error, but the part does not move in the exploded view. Reuse these names where they fit, or add new keys to `explode.js` as a separate configurator change.
3. **Section caps** group meshes by role (`profile` → PVC, `glass`, `gasket`, `hardware`). Each group must be closed solids (§2).
4. **The scenery wall opening** = the frame outside rectangle (0, 0)–(W, H). The wall exterior face = z max of the frame (0).
5. **Surface detail** (triplanar normal/roughness) is applied only to `role: "profile"` materials.

---

## 10. Provenance and traceability (org rules)

- **Provenance on every part**, in plain `extras` (not in `cfg`): `source_file`, `source_layer`, `source_block`, `sub_piece`, `source_section`, `source_insert_xy_in`, `assembly`, `side`, `units_source`, `length_rule`. Hardware also gets `placement_source`.
- **Approximations.** Add `note` wherever an approximation is used, tagged `preview-only`.
- **Measured values.** Report every value measured from a vector drawing (instead of a called-out dimension) with its scale check and an independent cross-check.
- **Report what was left out**: shims, screws, wood extensions, operators, …
- **Preview-only values.** Values chosen for the preview, like the opening angle or animation duration, are labelled preview-only. They are never presented as product data.

---

## 11. Verification checklist (run every check; never claim one passed without running it)

```bash
cd configurator
node tools/validate-glb.mjs ../glb/<Name>_cfg.glb --original ../glb/<Name>.glb   # must print OK
npm run test:deform        # double-hung regression (must still pass; unchanged files)
npm run test:casement      # casement regression (the test's hinge checks are casement-specific)
npm run test:awning        # horizontal-axis hinge logic (synthetic model)
npm run test:assembly      # multi-window: proves the new GLB places and aligns next to the others
```

To try it in the app: copy it to `configurator/public/` and open `npm run dev` → `?model=<Name>_cfg.glb`, or use **Load GLB…**. Adding it to the picker means a new `BUNDLED_MODELS` entry in `src/App.vue`.

Report the numbers for each of these:

1. Frame bbox x 0→W0, y 0→H0, max z = 0 (1e-6). A bbox per assembly, in inches.
2. Hierarchy listing. Only motion-group and hinge nodes have transforms. Each pivot + offset is exactly 0.
3. Every mesh is closed and consistently wound.
4. Split clearance per stretching part (≥ 10 mm), with vertices on both sides.
5. `canScale* === (below !== above)`. JSON booleans. Every node has a cfg.
6. Exterior/interior split: triangle counts (before → exterior + interior), with unchanged bboxes.
7. Animations:
   - key 0 (or the last key for close clips) = rest;
   - close clip is an exact reverse;
   - for a hinge: the free edge moves to +Z when opening outward (the lock stile for a casement, the bottom rail for an awning) and to −Z when opening inward;
   - collision sweep of the sash and hardware against the frame/extension over ≥ 11 steps.
8. Validator output pasted in full.
9. A table of every value read or measured: source, block/layer/page, value, cross-check. Every approximation and everything not modelled.
