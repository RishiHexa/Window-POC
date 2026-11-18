# Task: build a casement window GLB (geometry + configurator `extras.cfg`) from a DWG

You are building a GLB for a Vue + Three.js window configurator. It is a **visual preview only**. Nothing in this GLB is ever a source of manufacturing dimensions, cut lengths or BOM data. Still, every dimension must come from the drawing. Never invent a value.

Work only in `C:\Users\VICTUS\Desktop\Daivinci\window\POC`.

- **Input (read-only):** `<CASEMENT_DWG>` ← fill in the path to the casement DWG before running this prompt. Do not modify it.
- **Reference (read-only):** `glb/Window_V3.glb` and `glb/Window_V3_cfg.glb` (the double-hung this format was built for), plus `prompts/01-glb-userdata-prompt.md`.
- **Outputs (new files):**
  1. `glb/Casement_V1.glb`: geometry, materials, hierarchy, animation and provenance extras. No `cfg` yet.
  2. `glb/Casement_V1_cfg.glb`: the same file with `extras.cfg` added (Part B) and the PVC face split (Part C).
  3. The scripts you used: `prompts/build-casement-geometry.*` and `prompts/build-casement-cfg.mjs`.
  4. A report (Part D).

## Decisions already made (do not change them)

| item | decision |
|---|---|
| Window type | Casement, one sash, hinged on a vertical side |
| Reference size | **W0 = 0.6096 m (24 in), H0 = 0.9144 m (36 in)**, measured as the **frame outside** size, the same definition as V3 (V3's Frame spans exactly x 0 → 24 in, y 0 → 36 in) |
| Hinge side | Read it **from the DWG**. If the drawing does not show it unambiguously, stop and ask. |
| Opening direction (outward / inward) | Read it **from the DWG**. If not shown, stop and ask. |
| Preview opening angle | **90°**. This is a preview-only value chosen by the user on 2026-11-18, not product data. |
| Preview animation duration | 3 s. This is preview pacing only and may be changed. |
| Jamb extension | Model it **only if the DWG contains an extension block**. If the DWG has none, leave it out and say so in the report. Do not stop. |
| Hinge in GLB | A pivot node, an offset node and a rotation clip in the GLB (see Part A4) |

## Hard rules

1. **Every dimension comes from the DWG.** That covers profile cross-sections, insert positions, glass thickness and extension depth. If something you need is missing, ambiguous or contradictory, **stop and report**. Do not pick a plausible value.
2. **Do not invent profile codes.** Node names use the DWG block names (for example `09440I` in V3). If a block has no code, report it and ask.
3. **Units are metres** in the GLB. Check the DWG `INSUNITS` value and convert. 1 in = 0.0254 m exactly.
4. **Add `cfg` with Node.js `@gltf-transform/core` plus `@gltf-transform/extensions`, not Blender.** Blender writes booleans as 0/1, and the configurator requires JSON booleans. You may build the geometry with any tool (Python with ezdxf, Blender, or another), but Part B must be a separate Node step.
5. To read the DWG, convert it to DXF first (ODA File Converter or LibreDWG `dwg2dxf`), then parse it. ezdxf cannot read DWG directly.
6. Do not modify anything under `configurator/`. The configurator changes that casement support needs are a separate task (see the end of this prompt).

## Part A: geometry

### A1. Coordinate system (same as V3)

- Y-up, metres.
- X = width, 0 → W0. Y = height, 0 → H0. Z = depth.
- The origin is the **bottom-left outside corner of the frame, on its exterior face**.
- The frame's exterior face is at **z = 0**, and the interior goes toward **−Z**, so **exterior faces +Z**.
- "Left" and "right" are **as seen from the exterior**, looking toward −Z. In this view, left is low x.
- In the report, state whether the DWG elevation is drawn from the exterior or the interior, and how you mapped it.

### A2. Profiles

- Take each member's cross-section from the DWG section views:
  - the jamb (horizontal) section gives the X/Z section of the left and right members;
  - the head/sill (vertical) section gives the Y/Z section of the top and bottom members.
- Keep chambers as holes. Place each profile using its block insert position relative to the frame's outside corner.
- Extrude each member along its length, with **45° mitres at the outer corners of its assembly**. Lengths come from the section extents, as in V3 (`length_rule`).
- Make one mesh node per member per side. Each mesh has **exactly 1 primitive** (before Part C), its own mesh (no sharing), and triangles only (mode 4).
- Glazing tape or gaskets that the DWG draws as separate solids inside a block become their own mesh node, named `<member>_tape`.
- Glass is one solid per sash, using the IGU thickness from the DWG. Record any simplification in `note`.

### A3. Mesh requirements (the configurator rejects or mis-renders without these)

- POSITION is **float32 VEC3**. No Draco, meshopt or `KHR_mesh_quantization`. NORMAL is float32. Indices are UNSIGNED_SHORT or UNSIGNED_INT.
- Every part is a **closed, consistently wound solid**. The section view caps depend on it, so check it per mesh and report the result.
- Every node has an **identity transform** except the two hinge nodes in A4.
- Geometry is baked in absolute reference coordinates.

### A4. Hierarchy and hinge

```
Scene "Scene" → [Window_<frameCode>]
Window_<frameCode>                     identity, root
├─ Frame_<Side>_<code>                 identity
├─ FrameAccessory_<Side>_<code>        identity (only if the DWG has accessories)
├─ Extension_<Side>_<code>             identity (only if the DWG has an extension block)
└─ Sash_Hinge                          translation = P, rotation = identity at rest (animated)
   └─ Sash_HingeOffset                 translation = −P (static)
      ├─ Sash_<Side>_<code>            identity
      ├─ Sash_<Side>_<code>_tape       identity (if the DWG has tape)
      ├─ Bead_<Side>_<code>            identity (if the DWG has beads)
      └─ SashGlass                     identity
```

**The pivot P** is computed from the sash geometry at the reference size. It is not a free choice.

- Left hinge: `P.x` = min x over all `Sash_*` members. Right hinge: `P.x` = max x over all `Sash_*` members.
- `P.y` = 0.
- Outward opening: `P.z` = max z (the most exterior face) over all `Sash_*` members. Inward opening: `P.z` = min z.

Because `Sash_HingeOffset` cancels P, the sash meshes keep absolute coordinates and the assembled window at rest is identical to having identity transforms everywhere. Check this in Part D.

**Animation:**

- One clip named **`Sash_Hinge`**, with one channel: `Sash_Hinge.rotation`, LINEAR.
- Two keys: t = 0 s → `[0, 0, 0, 1]`, and t = 3 s → the quaternion for ±90° about +Y. glTF order is `[x, y, z, w]` = `[0, sin(θ/2), 0, cos(θ/2)]`.
- Choose the sign so that the sash's **free edge moves toward +Z for an outward-opening sash** (toward −Z for inward). Expected values:
  - left hinge, outward: θ = −90°, so `[0, -0.70710678, 0, 0.70710678]`
  - right hinge, outward: θ = +90°, so `[0, 0.70710678, 0, 0.70710678]`
- **Verify the sign numerically.** Rotate the free-edge midpoint of the sash about P with the final key and report its z before and after.
- There is no translation channel. Real casement hinges (four-bar or friction stays) slide as they open. This preview uses a simple pivot; record that in the root `extras.note`.

### A5. Materials

Copy these three materials from `glb/Window_V3.glb` **value-for-value**: base colour, metallic, roughness, `doubleSided`, `alphaMode` and extensions.

- `PVC_White`: `KHR_materials_clearcoat`
- `Glass_IGU`: BLEND, `KHR_materials_transmission`, `KHR_materials_ior`
- `Glazing_Tape`

PVC members use `PVC_White`, tape uses `Glazing_Tape`, and glass uses `Glass_IGU`.

### A6. Provenance extras (top-level `extras`, not `cfg`)

Use the same keys as V3 and fill only what the DWG gives you. Leave out a key rather than guessing it.

- **Every part:** `source_file`, `source_layer`, `source_block`, `sub_piece`, `source_section`, `source_insert_xy_in`, `assembly`, `side`, `units_source`, `length_rule`.
- **Glass:** add `note` for the simplification.
- **Root:** `source_file`, `window_type: "casement"`, `hinge_side`, `opens`, and `note` (the pivot simplification).

## Part B: `extras.cfg` (merge into existing `extras`; never replace them)

This is the same contract as `prompts/01-glb-userdata-prompt.md`, plus one additive hinge schema. JSON types are strict: booleans are JSON booleans, and every number is a JSON number.

### B1. Parts: `schema: "davinci.window.part/1"`

```json
{"schema":"davinci.window.part/1","role":"profile|gasket|glass","assembly":"<Assembly>","side":"left|right|top|bottom|infill",
 "canScaleX":<bool>,"canScaleY":<bool>,"x":{"split_m":0.3048,"below":<n>,"above":<n>},"y":{"split_m":0.4572,"below":<n>,"above":<n>},"colorZone":"<zone>"}
```

**Assembly names** (exact spelling): `Frame`, `FrameAccessory`, `Extension`, `Sash`, `Bead`. Glass and tape use `Sash`.

**Split factors.** There is a single sash, so there is no meeting rail and every assembly uses 0 → 1. Both splits sit at the reference centre.

| side | x (below, above) | y (below, above) | canScaleX | canScaleY |
|---|---|---|---|---|
| left | 0, 0 | 0, 1 | false | true |
| right | 1, 1 | 0, 1 | false | true |
| top | 0, 1 | 1, 1 | true | false |
| bottom | 0, 1 | 0, 0 | true | false |
| infill (glass) | 0, 1 | 0, 1 | true | true |

- For every axis where `below !== above`, the split must lie **≥ 10 mm from every vertex**, and there must be vertices on both sides of it. If any part fails (for example a notch at the midpoint), **stop and report**. Do not move the split.
- Rigid axes (`below === above`) have no clearance requirement.

**colorZone:**

- `glass` for glass and `gasket` for tape.
- For `profile` parts, decide the zone **per assembly**. Every part in an assembly gets the same zone. This rule reproduces every V3 assignment:
  - compute z_mid = (min z + max z) / 2 over all parts of the assembly, and Z_frame = the same over all Frame members;
  - if z_mid ≥ Z_frame, the zone is `exterior`; otherwise it is `interior`. This makes `Frame` always `exterior`.
- Report z_mid and the zone for each assembly.

### B2. Hinge nodes: `schema: "davinci.window.hinge/1"` (new, additive)

`Sash_Hinge`:

```json
{"schema":"davinci.window.hinge/1","role":"hingePivot","assembly":"Sash","clip":"Sash_Hinge","offsetNode":"Sash_HingeOffset",
 "axis":"y","pivot_m":[Px,Py,Pz],"pivotFactor":{"x":0|1,"y":0},"hingeSide":"left|right","opens":"outward|inward",
 "hingeSide_source":"<which DWG element showed the hinge side and swing>"}
```

`Sash_HingeOffset`:

```json
{"schema":"davinci.window.hinge/1","role":"hingeOffset","assembly":"Sash","pivotNode":"Sash_Hinge"}
```

`pivotFactor.x` is **0 for a left hinge** (the pivot does not move when the width changes) and **1 for a right hinge** (the pivot moves by ΔW).

### B3. Root `Window_<frameCode>`: `schema: "davinci.window.cfg/1"`

```json
{"schema":"davinci.window.cfg/1","units":"m","windowType":"casement",
 "reference":{"width_m":0.6096,"height_m":0.9144,"width_in":24,"height_in":36},
 "axes":{"width":"x","height":"y","depth":"z","exteriorFacing":"+z"},
 "colorZones":["exterior","interior"],
 "animations":[{"clip":"Sash_Hinge","node":"Sash_Hinge","motion":"rotate","axis":"y","openAngle_deg":90,
   "openAngle_source":"preview-only value chosen by user 2026-11-18; not product data","label":"Sash"}]}
```

`motion` is new. If it is absent, the entry means `"translate"`, which is how V3 behaves. Rotate entries have no `referenceTravel_m` or `travelPerDeltaHeight`, because the angle does not scale with size.

## Part C: split PVC into exterior and interior materials

Do this exactly as Part B of `prompts/01-glb-userdata-prompt.md`:

- Create `PVC_Exterior` and `PVC_Interior` as copies of `PVC_White`, with `extras.cfg.colorZone`.
- Classify triangles by face normal: n.z ≥ 0.5 → exterior; n.z ≤ −0.5 → interior; anything else → the node's `cfg.colorZone`. Use the vertex positions as-is. The sash meshes' own coordinates are absolute because the hinge offset cancels.
- Keep triangles in their original order. Leave out any empty primitive.
- Remove `PVC_White` only if nothing references it any more.
- Check the invariants: triangle count per mesh unchanged, the union of triangles equals the original set, the POSITION bbox is unchanged, and no vertex values change.

## Part D: verification and report (report the numbers)

1. **Overall size.** The Frame bbox is x 0 → 0.6096, y 0 → 0.9144, max z = 0 (tolerance 1e-6 m). Report the bbox for each assembly in inches.
2. **Hierarchy.**
   - Report the node list and hierarchy.
   - Every node except `Sash_Hinge` and `Sash_HingeOffset` has no translation, rotation, scale or matrix.
   - `Sash_Hinge.translation + Sash_HingeOffset.translation = [0, 0, 0]` exactly.
3. **Closed solids.** Every mesh is closed and consistently wound. List any that are not, and stop if there are any.
4. **Split clearance.** Report the nearest-vertex distance to each stretching split, per part.
5. **Hinge sign.** Report the free-edge midpoint z before and after the final key, and confirm the sash swings to the correct side.
6. **cfg types.** Every node has `extras.cfg`. `canScaleX === (x.below !== x.above)` and `canScaleY === (y.below !== y.above)` hold for every part, and all flags are JSON booleans.
7. **Part C counts.** Report the triangle counts per mesh: before, then after as exterior + interior.
8. **Validator.** Run `node configurator/tools/validate-glb.mjs glb/Casement_V1_cfg.glb --original glb/Casement_V1.glb`. You must pass `--original`; the default compares against V3. Paste the output.
   - **Expected:** errors for the two `davinci.window.hinge/1` nodes, because the validator does not know that schema yet. Possibly also errors for the rotate animation entry (missing `referenceTravel_m` / `travelPerDeltaHeight`).
   - List every error. Do not edit the validator to make it pass.
9. List everything you read from the DWG, with the block or layer name for each, and anything that did not match this prompt.
10. **Do not claim a check passed unless you ran it.**

## Not in scope: configurator changes needed before this GLB will load (separate task)

The current configurator rejects this file. The GLB is still correct to build now; these changes come next, and V3 must keep behaving identically:

- `schema.js`: accept `davinci.window.hinge/1`. Accept animation entries with `motion: "rotate"` (`axis` and `openAngle_deg` required). A missing `motion` still means translate.
- `WindowModel.js`:
  - exempt hinge nodes from the identity-transform check;
  - bind rotation clips (quaternion track) without travel scaling;
  - on `setSize`, set `Sash_Hinge.position = P + (ΔW × pivotFactor.x, ΔH × pivotFactor.y, 0)` and set `Sash_HingeOffset.position` to its negation.
- `explode.js`: add layout entries for `Sash`, `Bead`, `Sash_glass` and `Sash_gasket`. Today unknown assemblies just stay put.
- `validate-glb.mjs`: hinge and rotate support. Check that the clip has a `rotation` channel on `node`.
