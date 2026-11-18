# Casement_V1 GLB — build report (Part D)

Date: 2026-11-18. Source: `Casement_and_Fixed_-_PVC_-_3.25.dwg` (AutoCAD 2018 format, AC1032), read-only.
Visual preview only — nothing here is a source of manufacturing dimensions, cut lengths or BOM data.

## Files

| file | what |
|---|---|
| `glb/Casement_V1.glb` | geometry, materials, hierarchy, hinge clip, provenance extras (no `cfg`) |
| `glb/Casement_V1_cfg.glb` | + `extras.cfg` (Part B) + PVC split (Part C) |
| `prompts/build-casement-geometry.py` | Part A (Python: ezdxf, shapely, triangle, numpy) |
| `prompts/build-casement-cfg.mjs` | Parts B + C (Node: `@gltf-transform/core` 4.5.1 + `/extensions`) |

Reproduce:
```
dwg2dxf -y -o casement.dxf "Casement_and_Fixed_-_PVC_-_3.25.dwg"      # LibreDWG (built from source)
pip install ezdxf shapely triangle numpy
python3 prompts/build-casement-geometry.py casement.dxf glb/Window_V3.glb glb/Casement_V1.glb
npm i @gltf-transform/core@4 @gltf-transform/extensions@4              # outside configurator/
node prompts/build-casement-cfg.mjs glb/Casement_V1.glb glb/Casement_V1_cfg.glb
```

## Decisions not readable from the DWG (asked, answered by the user 2026-11-18)

The DWG contains **no text, dimensions or legend** (entities: 300 INSERT, 83 LINE, 34 LWPOLYLINE, 2 WIPEOUT).

| item | DWG shows | decision |
|---|---|---|
| Hinge side | 24×36 casement elevation (x 0→24 in, layer PVC): two solid swing lines meet at drawing-left, apex (3.143, 18.0) | User: elevation is drawn **from the exterior** → **left** hinge (seen from exterior). Mapping: DWG x = model x, no mirror. |
| Opening | swing lines are Continuous; no in/out notation | User: **outward** |
| Glazing | two section sets: 7/8 in IGU (VERRE-875-3MM + bead 09604XB + "cale a thermo") and 1-1/4 in (VERRE-1.250-3MM + bead 09c07 + "CALE 1.25") | User: **7/8 in** set |

## 1. Overall size (bbox per assembly, inches, from `Casement_V1_cfg.glb`)

| assembly | x | y | z |
|---|---|---|---|
| Frame | 0.0000 → 24.0000 | 0.0000 → 36.0000 | −3.2500 → 0.0000 |
| Extension | 0.0150 → 23.9850 | 0.0150 → 35.9850 | −7.3750 → −2.7500 |
| Sash (profiles) | 0.8254 → 23.1746 | 0.8254 → 35.1746 | −2.6350 → −0.2519 |
| Sash tape/gaskets | 0.6056 → 23.3944 | 0.6056 → 35.3944 | −2.7150 → −0.4664 |
| Bead (+ its tape) | 2.4147 → 21.5853 | 2.4147 → 33.5853 | −2.6350 → −1.8902 |
| Glass | 2.6302 → 21.3698 | 2.6302 → 33.3698 | −1.8902 → −1.0152 |

Frame in metres: min [−7.8e−15, −1.2e−11, −0.08255], max [0.6096000075, 0.9143999815, 0.0] → **OK** within 1e−6 m (float32).

## 2. Hierarchy

```
Window_09700D
├─ Frame_Bottom/Left/Right/Top_09700D
├─ Extension_Bottom/Left/Right/Top_01436
└─ Sash_Hinge            T = [0.015382238663733006, 0, -0.006398800760507584]
   └─ Sash_HingeOffset   T = [-0.015382238663733006, 0, 0.006398800760507584]
      ├─ Sash_{Bottom,Left,Right,Top}_09601XI  (+ _tape each)
      ├─ Bead_{Bottom,Left,Right,Top}_09604XB  (+ _tape each)
      └─ SashGlass
```
28 nodes, 25 mesh nodes, each with its own mesh. No FrameAccessory (none in this DWG's casement sections).
- Nodes other than the two hinge nodes with translation/rotation/scale/matrix: **none** (checked).
- `Sash_Hinge.translation + Sash_HingeOffset.translation = [0.0, 0, 0.0]` — **exactly zero** (checked). Neither hinge node has a rotation/scale at rest, so the assembled window at rest equals identity transforms everywhere.

**Pivot P** (computed over all `Sash_*` meshes, including `Sash_*_tape`): P.x = min x = 0.6056 in (0.015382 m), P.y = 0, P.z = max z = −0.2519 in (−0.006399 m). Note: the min x comes from the sash weatherstrip (PB-9231-187) at 0.6056 in. The sash PVC outline itself starts at 0.8254 in. If P should use profiles only, P.x would be 0.020966 m. I followed the prompt literally.

## 3. Closed solids

All 25 meshes are **closed (watertight) and consistently wound, with positive volume and 0 degenerate triangles** (trimesh, vertices merged by position; checked on both GLBs). POSITION/NORMAL float32 VEC3, indices UNSIGNED_SHORT, mode 4, no Draco/meshopt/quantization.
Cap triangulation: constrained Delaunay with no Steiner points. Each cap's triangle areas sum to the section area (asserted per part).

## 4. Split clearance (nearest vertex to each stretching split)

All parts pass (≥ 10 mm, vertices on both sides). Minimum per part:

| part | axis | nearest (mm) |
|---|---|---|
| Frame_Bottom / Top | x | 240.152 |
| Frame_Left / Right | y | 392.552 |
| Extension_Bottom / Top | x | 282.575 |
| Extension_Left / Right | y | 434.975 |
| Sash_Bottom / Top (+_tape) | x | 224.975 |
| Sash_Left / Right (+_tape) | y | 377.375 |
| Bead_Bottom / Top (+_tape) | x | 224.975 |
| Bead_Left / Right (+_tape) | y | 377.375 |
| SashGlass | x / y | 237.993 / 390.393 |

## 5. Hinge sign

Clip `Sash_Hinge`: one channel `Sash_Hinge.rotation`, LINEAR, t = [0, 3] s, keys [0,0,0,1] → [0, −0.70710677, 0, 0.70710677] (θ = −90°, left hinge, outward).
Free-edge midpoint (sash max x, mid y, mid z): before **z = −0.037680 m**, after the final key **z = +0.572437 m** (x 0.594218 → 0.046663). Δz = +0.610 m → it moves toward +Z (exterior), so the sash swings **outward**. ✔

## 6. cfg types

Every node has `extras.cfg`. For all 25 parts, `canScaleX === (x.below !== x.above)` and `canScaleY === (y.below !== y.above)` hold, all flags are JSON booleans, and all numbers are JSON numbers (checked in Python on the written file). All Part A provenance extras survive unchanged.

colorZone per assembly (z_mid over the assembly's profile parts, Z_frame = −0.041275 m):

| assembly | z_mid (m) | zone |
|---|---|---|
| Frame | −0.041275 | exterior |
| Extension | −0.128587 | interior |
| Sash | −0.036664 (−0.037680 incl. tape+glass) | exterior |
| Bead | −0.058232 | interior |

## 7. Part C triangle counts (before → exterior + interior)

| mesh | before | ext + int |
|---|---|---|
| Frame_Bottom_09700D | 572 | 504 + 68 |
| Frame_Left_09700D | 572 | 500 + 72 |
| Frame_Right_09700D | 588 | 516 + 72 |
| Frame_Top_09700D | 572 | 504 + 68 |
| Extension_* (×4) | 28 | 6 + 22 |
| Sash_*_09601XI (×4) | 480 | 410 + 70 |
| Bead_Bottom / Left | 84 | 14 + 70 |
| Bead_Right / Top | 84 | 12 + 72 |

Tape (20/636 tris) and glass (12) are untouched. `PVC_White` was removed because nothing references it any more. `PVC_Exterior`/`PVC_Interior` are identical to V3 `PVC_White` (values, clearcoat, doubleSided) plus `extras.cfg.colorZone`. Invariants were checked by the script and again on the written files: triangle counts unchanged, triangle sets identical, POSITION bit-identical, bbox unchanged.

## 8. Validator (run on the device, Node v22.23.4)

```
$ node configurator/tools/validate-glb.mjs glb/Casement_V1_cfg.glb --original glb/Casement_V1.glb
Validated glb/Casement_V1_cfg.glb
  nodes: 28, mesh parts: 25, animations: 1
  info: geometric min width  6.29 in (159.6 mm)
  info: geometric min height 6.29 in (159.6 mm)
  info: Part B present: PVC_Exterior=exterior, PVC_Interior=interior
  WARN: Sash_HingeOffset: has explicit translation; configurator requires identity
  WARN: Sash_Hinge: has explicit translation; configurator requires identity
  ERROR: Sash_HingeOffset: schema must be "davinci.window.part/1" (got "davinci.window.hinge/1")
  ERROR: Sash_HingeOffset: role must be one of profile|gasket|glass
  ERROR: Sash_HingeOffset: colorZone must be one of exterior|interior|glass|gasket
  ERROR: Sash_HingeOffset.x: missing axis object
  ERROR: Sash_HingeOffset.y: missing axis object
  ERROR: Sash_Hinge: schema must be "davinci.window.part/1" (got "davinci.window.hinge/1")
  ERROR: Sash_Hinge: role must be one of profile|gasket|glass
  ERROR: Sash_Hinge: colorZone must be one of exterior|interior|glass|gasket
  ERROR: Sash_Hinge.x: missing axis object
  ERROR: Sash_Hinge.y: missing axis object
  ERROR: Window_09700D.animations[0].referenceTravel_m must be a non-zero number
  ERROR: Window_09700D.animations[0].travelPerDeltaHeight must be a number
  ERROR: root animations: clip "Sash_Hinge" does not translate node "Sash_Hinge"
FAILED (13 error(s))
```
All 13 errors are expected: 10 for the two `davinci.window.hinge/1` nodes, 2 for the rotate animation entry's missing travel fields, and 1 because the clip rotates rather than translates. The 2 warnings are for the hinge translations. The additive-only comparison against `Casement_V1.glb` reported no errors (nodes, hierarchy, transforms, extras, bbox, triangle counts, animation samplers). The validator was not edited.

## 9. What was read from the DWG

`INSUNITS = 1` (inch), converted with 1 in = 0.0254 m. Section groups used: jamb row at DWG y 37–49 above the 24×36 elevation, and head/sill column at DWG x −12–0.

| element | block (layer) | inserts (DWG x, y) | used for |
|---|---|---|---|
| Frame | `09700D (Architecte)` (PVC) | jamb (0, 43.125), (24, 43.125); head/sill (−6.25, 0), (−6.25, 36) | outline + 8 chambers; exterior face = DWG y 46.375 (jamb) / DWG x −3.0 (head/sill) → z = 0 |
| Sash | `09601XI (avec PB-9231-187) (Architecte)` (PVC) | jamb (2.0727, 44.925), (21.9273, 44.925); head/sill (−4.45, 2.0727), (−4.45, 33.9273) | outline + 7 chambers; 5 separate solids outside the outline (2 hatched PB-9231-187 pieces, glazing tape at the glass, 2 seals) → `Sash_*_tape` |
| Bead | `09604XB (Architecte)` (PVC) | jamb (2.5372, 43.895), (21.4628, 43.895); head/sill (−5.48, 2.5372), (−5.48, 33.4628) | outline + 1 chamber; 1 gasket at the glass → `Bead_*_tape` |
| Extension | `01436 (Architecte)` (PVC) | jamb (0.445, 39.045), (23.555, 39.045); head/sill (−10.33, 0.445), (−10.33, 35.555) | single loop |
| Glass | `VERRE-875-3MM (Architecte)` (UNITE SCELLE) | jamb (2.6302, 44.9223), (21.3698, 44.9223); head/sill (−4.4527, 2.6302), (−4.4527, 33.3698) | lite edges → x/y extents; IGU thickness 0.875 in |
| Swing lines | LINE (PVC) | (20.857, 32.857)→(3.143, 18)→(20.857, 3.143) | hinge side (with the user's viewing-side answer) |

Mitre corners came from the section extents of each assembly's profile outlines: Frame 0/24 × 0/36, Sash 0.8254/23.1746 × 0.8254/35.1746, Bead 2.4147/21.5853 × 2.4147/33.5853, Extension 0.015/23.985 × 0.015/35.985. These match the elevation's mitre lines (frame corner 0,0; sash corner 0.825).

### Not modelled, or not matching the prompt

1. **Wood extension `EXTENSION 0.705 X 4.580 (Architecte)`** (layer **BOIS**, 4 inserts, 0.705 × 4.58 in section) is **not modelled**. It has no profile code, so under hard rule 2 I'm asking rather than naming it. It is wood, and none of the three V3 materials fits it. V3's precedent names the Extension after the PVC `01436`, which is what I modelled. **Question: should the wood piece be added, and under what name and material?**
2. **Shims** `cale a thermo 1 x 0.1875` (layer QUINCALLERIE, 4 inserts) are setting blocks, not tape or gaskets. Not modelled (V3 has no hardware either).
3. **`Bead_*_tape`** is not listed in the prompt's hierarchy, but the bead block draws a separate gasket solid, so the A2 rule created it. Its `cfg.assembly` is `Sash` (rule B1: tape uses Sash), while its provenance `extras.assembly` is `Bead`.
4. Each `Sash_*_tape` mesh holds 5 disjoint closed solids in one primitive (one node per side, per rule A2).
5. **Glass depth** differs between the sections by 0.000006 in (jamb −1.89017/−1.01517, head/sill −1.890164/−1.015164). I used the jamb values. Glass is one solid of 0.875 in: two 3 mm lites plus spacer merged (`note`).
6. The left and right jamb frame outlines flatten to 81 vs 85 vertices (arc flattening of the mirrored insert), so their triangle counts are 572 vs 588. Section area is identical to 1e−5 in².
7. gltf-transform writes interleaved vertex buffers (byteStride 24) in `Casement_V1_cfg.glb`. That is valid glTF, and the validator and Three.js read it. Normals are flat (vertices are not shared between triangles).
8. The DWG also contains other assemblies that were not used: the 1-1/4 in glazing set (09c07, VERRE-1.250, CALE 1.25), casement + fixed combinations, a twin casement with mullion (09610B/09611B), and fixed units (09702XIB, 09703XI, 09660B, 09760B, 09460, 09461, Plaque 3 X 0.125).
9. The preview pivot rotates about a fixed axis. Real casement hardware slides as it opens, so this isn't modelled (root `extras.note`). At 90° the sash simply swings about P, and no collision check was made against the frame.

## Not run

- Loading in the configurator: it rejects this file until the separate `schema.js` / `WindowModel.js` / `explode.js` / `validate-glb.mjs` changes are made. Not attempted. Nothing under `configurator/` was modified.
- No in-browser render. The rest and open poses were checked numerically and with an offline matplotlib render only.

---

# Addendum (2026-11-18): Casement_V2, with the real hinge motion

Feedback: casements don't swing on a fixed pin. V1 is kept unchanged. V2 replaces only the two hinge nodes, the clip and the root note. Geometry, materials, provenance and cfg parts are identical to V1, apart from the new hinge and animation fields.

Files: `glb/Casement_V2.glb`, `glb/Casement_V2_cfg.glb`, `prompts/build-casement-hinge.py` (V1 → V2), `prompts/build-casement-cfg.mjs` (now also writes linkage cfg when root `extras.hinge_hardware` is present; re-running it on V1 gives byte-identical extras, checked).

```
python3 prompts/build-casement-hinge.py glb/Casement_V1.glb glb/Casement_V2.glb
node prompts/build-casement-cfg.mjs glb/Casement_V2.glb glb/Casement_V2_cfg.glb
```

## Hardware and sources

- Soniplastics *Casement and Awning – PVC – 3.25* (PDF p.90 = sheet 21, "#50.10 operator Truth application, 3¼" casement"): hinges = **Truth #14.97**, qty 2 (head and sill). The plan view puts the hinge on the jamb that is left as seen from the exterior, consistent with V1.
- Truth **"14.97 CUSTOMER PAGE"** (`AT WCA 14.97 Maxim Hinges.pdf`), 1:1, showing the hinge closed and open at 90°.

The mechanism is a slider-crank. The sash arm pivots on shoe A, which slides along the track. The support arm runs from sash-arm hole B to a fixed, adjustable stud S on the track.

## Values (inches): measured from vector geometry, not called-out dimensions

| value | measurement | cross-check |
|---|---|---|
| scale, Truth page | track holes 4.0000 / 4.0000 / 3.3750 | called-out 4.00 / 4.00 / 3.38 ✔ |
| A–B | 4.6631 (closed view), 4.6633 (90° view) → **4.6632** | |
| B–S (support arm) | 6.8369 (closed), 6.8373 (90°) → **6.8370** | |
| A–S closed | 11.5000 (A, B, S collinear) | = A–B + B–S = 11.5002 ✔ |
| A–S at 90° | 5.0040 → shoe travel **6.496** | Truth text: "sash moves 6-1/2"" ✔ |
| scale, Soniplastics p.21 | frame width 23.030 at 1:2 | called-out 23.028 ✔ |
| stud S from frame outside edge (hinge side) | **12.4375** | |
| sash-arm pivot hole, closed | 0.9350 | linkage predicts 12.4375 − 11.5002 = 0.9373 ✔ (0.002) |
| pivot line depth from frame exterior face | **1.0152** (z = −1.0152) | inside sash depth 0.252–2.635 ✔ |

Not reconciled: Soniplastics calls out **.827"** from the frame edge to a hole near the hinge end of the top bar, and I measured that hinge pivot hole at 0.935. I couldn't tell which hole the .827 refers to. The model uses the linkage-consistent 0.9373.

## Result

- `Sash_Hinge` rest translation P0 = [0.023807, 0, −0.025786] m (= closed shoe pivot A). `Sash_HingeOffset` = −P0. Sum = [0, 0, 0] exactly. ✔
- Clip `Sash_Hinge` has 2 channels on `Sash_Hinge`: **rotation** and **translation**, 31 LINEAR keys over 0–3 s. The angle runs 0 → 90° (θ = −φ, left hinge outward). Translation x = S − (a·cosφ + √(L² − a²·sin²φ)), so the pivot goes from x = 0.9373 to 7.4376 in (**6.500 in** of slide), with z constant.
- Linkage constraint along the clip: support-arm length error ≤ 1.1e−8 m at keys and ≤ 0.07 mm at mid-key interpolation. ✔
- Free-edge midpoint: z −0.0377 → +0.3691 (t = 1.5 s) → +0.5446 m (t = 3 s). Outward ✔
- Collision sweep (61 time steps; sash vertices plus 20k surface samples against frame and extension solids): **no PVC, bead or glass penetration**. The only overlaps are the sash weatherstrips (`Sash_*_tape`), about 0.88 mm. They already exist at rest (seal compression as drawn in the DWG) and persist while the head/sill seals slide. V1 shows the same seal overlap.
- cfg: `Sash_Hinge.cfg` gains `motion: "slider-crank"` and `linkage {model, trackAxis, stud_m, shoeToJoint_m, supportArm_m, shoeTravelAtOpen_m, note, source}`. The root animation entry becomes `motion: "rotate+slide"` with `slideAxis: "x"` and `slideTravel_m: 0.165108`. Root extras gain `hinge_hardware` and an updated `note`.
- Deviation from the original prompt (A4): P is now the hinge's shoe pivot, not min x / max z of the sash meshes.
- Not modelled: the hinge, track and arm parts themselves, which are not in the DWG. The stud's eccentric adjustment uses the nominal position.

## Validator (device)

```
$ node configurator/tools/validate-glb.mjs glb/Casement_V2_cfg.glb --original glb/Casement_V2.glb
  nodes: 28, mesh parts: 25, animations: 1
  WARN: Sash_HingeOffset / Sash_Hinge: has explicit translation
  ERROR ×10: Sash_HingeOffset / Sash_Hinge not davinci.window.part/1 (schema, role, colorZone, x, y)
  ERROR: Window_09700D.animations[0].referenceTravel_m must be a non-zero number
  ERROR: Window_09700D.animations[0].travelPerDeltaHeight must be a number
FAILED (12 error(s))
```
All 12 errors are expected (hinge schema and rotate entry). The V1 error "clip does not translate node" is gone, because the clip now translates `Sash_Hinge`.

## Additional configurator work (separate task, in addition to the earlier list)

- Bind the clip's translation track **as an absolute pivot path**: add (ΔW·pivotFactor.x, ΔH·pivotFactor.y, 0) to every key. Don't scale it, because shoe travel is hardware-fixed and doesn't grow with width.
- Accept `motion: "rotate+slide"` / `"slider-crank"`.
