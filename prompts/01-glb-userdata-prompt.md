# Task: add configurator userData (glTF `extras.cfg`) to `glb/Window_V3.glb`

You are preparing a GLB for a Vue + Three.js window configurator. The configurator lets the user change **width**, **height**, **exterior colour**, **interior colour**, and play the sash animations. Three.js `GLTFLoader` copies every node's glTF `extras` into `object.userData`, so the configurator reads everything it needs from `extras.cfg`.

Work only in `C:\Users\VICTUS\Desktop\Daivinci\window\POC`.

- **Input (read-only):** `glb/Window_V3.glb`. Do NOT modify or overwrite it.
- **Output:** `glb/Window_V3_cfg.glb` (new file).

## Hard rules

1. **Additive only.** Do not change any vertex position, normal, UV, index order, node transform, node name, node hierarchy, animation sampler/keyframe, or any existing `extras` key. Existing extras (`source_file`, `source_block`, `length_rule`, `lower_sash_open`, `sash_travel_in`, …) must survive byte-for-byte in value.
2. **Edit the glTF programmatically.** Use Node.js with `@gltf-transform/core` (+ `@gltf-transform/extensions` so `KHR_materials_clearcoat`, `KHR_materials_transmission` and `KHR_materials_ior` are kept). For Part A alone, a raw rewrite of the GLB JSON chunk is also fine. **Do not round-trip through Blender.** It turns booleans into ints, and it can reorder or re-precision data.
3. All new data goes under the key **`cfg`**, inside the node's (or material's) existing `extras` object. Merge it in. Never replace `extras`.
4. JSON types are strict: `canScaleX`/`canScaleY` are JSON booleans, and every number is a JSON number (not a string).
5. If anything does not match the facts below (a node is missing, a bbox differs, a mesh has more than one primitive before you start), **stop and report**. Do not guess or invent values.

## Verified facts about Window_V3.glb (do not re-derive — check them)

- Units are metres. All 41 nodes have **identity transforms**. Geometry is baked in absolute coordinates.
- Reference size: **W0 = 0.6096 m (24 in)**, **H0 = 0.9144 m (36 in)**.
- Axes: X = width (0 → 0.6096), Y = height (0 → 0.9144), Z = depth. The exterior face is at z = 0, and the interior goes toward −Z (Extension reaches −0.209). **Exterior faces +Z.**
- Root node is `Window_09440I`, with children: 12 frame/extension/accessory meshes, `LowerSash_Moving` (13 children) and `UpperSash_Moving` (13 children).
- 38 mesh nodes, each with exactly 1 primitive and its own mesh (no sharing).
- Materials: `PVC_White` (clearcoat), `Glass_IGU` (transmission + ior, BLEND), `Glazing_Tape`.
- Animations: `LowerSash_Moving` and `UpperSash_Moving`. Both are LINEAR translation on Y with 330 keys, over 0.0417 → 13.75 s.
  - Lower: y from 0 to +0.3474 (≈ 0–7 s).
  - Upper: y from 0 to −0.3474 (≈ 7–13.75 s).
  - Root extras give `sash_travel_in = 13.6777` (= 0.347414 m).

## How the configurator deforms parts (so you understand the data)

The profiles are 45° mitred. A plain `scale` would skew the mitres, so the configurator uses a **split-plane stretch** per axis.

```
ΔW = W − 0.6096        ΔH = H − 0.9144
x' = x + ΔW × (x < cfg.x.split_m ? cfg.x.below : cfg.x.above)
y' = y + ΔH × (y < cfg.y.split_m ? cfg.y.below : cfg.y.above)
z' = z                 (depth never changes)
```

- `below == above` means the part does not stretch on that axis. It is translated rigidly by `Δ × below`, so `canScale? = false`.
- `below != above` means the part stretches on that axis: the vertices on each side of the split move by different amounts, so `canScale? = true`.
- Height is shared between the sashes: the meeting rail moves by ½ΔH. Lower-sash parts use factors 0 → 0.5, and upper-sash parts use 0.5 → 1.
- Every split plane was checked against the real vertices. Each one lies ≥ 10 mm from any vertex.

## Part A — node `extras.cfg` (REQUIRED)

Merge the following object into `extras.cfg` of the node with that exact name. Every one of the 41 nodes gets an entry. `Window_09440I` is the root config.

```json
{
  "Extension_Bottom_01436": {"schema":"davinci.window.part/1","role":"profile","assembly":"Extension","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":0,"above":0},"colorZone":"interior"},
  "Extension_Left_01436": {"schema":"davinci.window.part/1","role":"profile","assembly":"Extension","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.4572,"below":0,"above":1},"colorZone":"interior"},
  "Extension_Right_01436": {"schema":"davinci.window.part/1","role":"profile","assembly":"Extension","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.4572,"below":0,"above":1},"colorZone":"interior"},
  "Extension_Top_01436": {"schema":"davinci.window.part/1","role":"profile","assembly":"Extension","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":1,"above":1},"colorZone":"interior"},
  "Frame_Bottom_09440I": {"schema":"davinci.window.part/1","role":"profile","assembly":"Frame","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":0,"above":0},"colorZone":"exterior"},
  "Frame_Left_09440I": {"schema":"davinci.window.part/1","role":"profile","assembly":"Frame","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.4572,"below":0,"above":1},"colorZone":"exterior"},
  "Frame_Right_09440I": {"schema":"davinci.window.part/1","role":"profile","assembly":"Frame","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.4572,"below":0,"above":1},"colorZone":"exterior"},
  "Frame_Top_09440I": {"schema":"davinci.window.part/1","role":"profile","assembly":"Frame","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":1,"above":1},"colorZone":"exterior"},
  "FrameAccessory_Bottom_09227": {"schema":"davinci.window.part/1","role":"profile","assembly":"FrameAccessory","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":0,"above":0},"colorZone":"exterior"},
  "FrameAccessory_Bottom_09526": {"schema":"davinci.window.part/1","role":"profile","assembly":"FrameAccessory","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":0,"above":0},"colorZone":"exterior"},
  "FrameAccessory_Bottom_09641": {"schema":"davinci.window.part/1","role":"profile","assembly":"FrameAccessory","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":0,"above":0},"colorZone":"exterior"},
  "FrameAccessory_Top_09228": {"schema":"davinci.window.part/1","role":"profile","assembly":"FrameAccessory","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.4572,"below":1,"above":1},"colorZone":"exterior"},
  "LowerBead_Bottom_09204": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerBead","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.2565,"below":0,"above":0},"colorZone":"interior"},
  "LowerBead_Left_09204": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerBead","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.2565,"below":0,"above":0.5},"colorZone":"interior"},
  "LowerBead_Right_09204": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerBead","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.2565,"below":0,"above":0.5},"colorZone":"interior"},
  "LowerBead_Top_09805": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerBead","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.2565,"below":0.5,"above":0.5},"colorZone":"interior"},
  "LowerGlass": {"schema":"davinci.window.part/1","role":"glass","assembly":"LowerSash","side":"infill","canScaleX":true,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.2565,"below":0,"above":0.5},"colorZone":"glass"},
  "LowerSash_Bottom_09825": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerSash","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.2565,"below":0,"above":0},"colorZone":"interior"},
  "LowerSash_Bottom_09825_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"LowerSash","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.2565,"below":0,"above":0},"colorZone":"gasket"},
  "LowerSash_Left_09822": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerSash","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.2565,"below":0,"above":0.5},"colorZone":"interior"},
  "LowerSash_Left_09822_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"LowerSash","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.2565,"below":0,"above":0.5},"colorZone":"gasket"},
  "LowerSash_Right_09822": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerSash","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.2565,"below":0,"above":0.5},"colorZone":"interior"},
  "LowerSash_Right_09822_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"LowerSash","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.2565,"below":0,"above":0.5},"colorZone":"gasket"},
  "LowerSash_Top_09823": {"schema":"davinci.window.part/1","role":"profile","assembly":"LowerSash","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.2565,"below":0.5,"above":0.5},"colorZone":"interior"},
  "LowerSash_Top_09823_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"LowerSash","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.2565,"below":0.5,"above":0.5},"colorZone":"gasket"},
  "UpperBead_Bottom_09204": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperBead","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.646,"below":0.5,"above":0.5},"colorZone":"exterior"},
  "UpperBead_Left_09204": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperBead","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.646,"below":0.5,"above":1},"colorZone":"exterior"},
  "UpperBead_Right_09204": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperBead","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.646,"below":0.5,"above":1},"colorZone":"exterior"},
  "UpperBead_Top_09204": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperBead","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.646,"below":1,"above":1},"colorZone":"exterior"},
  "UpperGlass": {"schema":"davinci.window.part/1","role":"glass","assembly":"UpperSash","side":"infill","canScaleX":true,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.646,"below":0.5,"above":1},"colorZone":"glass"},
  "UpperSash_Bottom_09824": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperSash","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.646,"below":0.5,"above":0.5},"colorZone":"exterior"},
  "UpperSash_Bottom_09824_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"UpperSash","side":"bottom","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.646,"below":0.5,"above":0.5},"colorZone":"gasket"},
  "UpperSash_Left_09822": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperSash","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.646,"below":0.5,"above":1},"colorZone":"exterior"},
  "UpperSash_Left_09822_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"UpperSash","side":"left","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":0,"above":0},"y":{"split_m":0.646,"below":0.5,"above":1},"colorZone":"gasket"},
  "UpperSash_Right_09822": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperSash","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.646,"below":0.5,"above":1},"colorZone":"exterior"},
  "UpperSash_Right_09822_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"UpperSash","side":"right","canScaleX":false,"canScaleY":true,"x":{"split_m":0.3048,"below":1,"above":1},"y":{"split_m":0.646,"below":0.5,"above":1},"colorZone":"gasket"},
  "UpperSash_Top_09825": {"schema":"davinci.window.part/1","role":"profile","assembly":"UpperSash","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.646,"below":1,"above":1},"colorZone":"exterior"},
  "UpperSash_Top_09825_tape": {"schema":"davinci.window.part/1","role":"gasket","assembly":"UpperSash","side":"top","canScaleX":true,"canScaleY":false,"x":{"split_m":0.3048,"below":0,"above":1},"y":{"split_m":0.646,"below":1,"above":1},"colorZone":"gasket"},
  "LowerSash_Moving": {"schema":"davinci.window.group/1","role":"motionGroup","assembly":"LowerSash","clip":"LowerSash_Moving"},
  "UpperSash_Moving": {"schema":"davinci.window.group/1","role":"motionGroup","assembly":"UpperSash","clip":"UpperSash_Moving"},
  "Window_09440I": {"schema":"davinci.window.cfg/1","units":"m","reference":{"width_m":0.6096,"height_m":0.9144,"width_in":24,"height_in":36},"axes":{"width":"x","height":"y","depth":"z","exteriorFacing":"+z"},"colorZones":["exterior","interior"],"animations":[{"clip":"LowerSash_Moving","node":"LowerSash_Moving","axis":"y","referenceTravel_m":0.347414,"travelPerDeltaHeight":0.5,"label":"Lower sash"},{"clip":"UpperSash_Moving","node":"UpperSash_Moving","axis":"y","referenceTravel_m":0.347414,"travelPerDeltaHeight":0.5,"label":"Upper sash"}]}
}
```

Field meanings:

| field | meaning |
|---|---|
| `schema` | `davinci.window.part/1` (mesh part), `davinci.window.group/1` (animated sash group), `davinci.window.cfg/1` (root) |
| `role` | `profile` (PVC extrusion, colourable), `gasket` (glazing tape, not colourable), `glass`, `motionGroup` |
| `canScaleX` / `canScaleY` | `true` iff the part stretches along width / height (`below !== above` on that axis) |
| `x` / `y` | `{ split_m, below, above }`: split plane in reference metres, plus the fraction of ΔW/ΔH applied to vertices below and above it |
| `colorZone` | `exterior` / `interior`: which colour picker drives this part's PVC. This is the default for side faces in Part B. `glass` and `gasket` are not colourable |
| root `animations[]` | the configurator scales keyframe values on `axis` by `(referenceTravel_m + travelPerDeltaHeight × ΔH) / referenceTravel_m` |

## Part B — split PVC into exterior / interior materials (REQUIRED, separate step)

So that exterior and interior colours can differ on the same profile:

1. Create two new materials, `PVC_Exterior` and `PVC_Interior`. Each is an exact copy of `PVC_White`: same baseColorFactor, metallic, roughness, clearcoat, doubleSided.
   - Add `extras: { "cfg": { "colorZone": "exterior" } }` to `PVC_Exterior` and `extras: { "cfg": { "colorZone": "interior" } }` to `PVC_Interior`.
2. For every mesh whose primitive uses `PVC_White`, classify each triangle by its face normal `n = normalize((v1−v0) × (v2−v0))`, using the position data as-is:
   - `n.z ≥ 0.5` → exterior
   - `n.z ≤ −0.5` → interior
   - otherwise (side, chamber and mitre faces) → the node's `cfg.colorZone` from Part A
3. Replace the single primitive with up to two primitives, one per material. They share or copy the same vertex attributes. Indices are the subset of triangles in their **original order**. If a subset is empty, omit that primitive.
4. Do not touch the `Glass_IGU` or `Glazing_Tape` primitives. Remove `PVC_White` only if nothing references it any more.

Part B invariants (check these):

- For each mesh, total triangle count is unchanged.
- The union of triangles equals the original set.
- POSITION min/max per mesh is unchanged.
- No vertex values have changed.

## Part C — verification (REQUIRED, report numbers)

1. Re-open `glb/Window_V3_cfg.glb`, then confirm all of the following:
   - Node count is 41, with the same names and hierarchy.
   - All transforms are still identity.
   - 2 animations are present, with identical key counts and values.
   - Every original `extras` key is still present with the same value.
2. Every node has `extras.cfg` deep-equal to the Part A map.
3. For every part: `canScaleX === (x.below !== x.above)` and `canScaleY === (y.below !== y.above)`.
4. Report the triangle counts per mesh (before, then after as exterior + interior) and the before/after POSITION bboxes.
5. Run `node configurator/tools/validate-glb.mjs glb/Window_V3_cfg.glb` (provided by the configurator project) and paste its output.
6. Do not claim a check passed unless you ran it.

## Deliverable

- `glb/Window_V3_cfg.glb`
- The script you used, saved as `prompts/build-window-cfg.mjs`
- A short report: what changed, the verification output, and anything that did not match the facts above.
