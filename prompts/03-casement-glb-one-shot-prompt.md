# Task: build an animated casement window GLB (geometry + hinge hardware + configurator `extras.cfg`) from a DWG and hardware drawings

You are building a GLB for a Vue + Three.js window configurator. It is a **visual preview only**: nothing in it is ever a source of manufacturing dimensions, cut lengths or BOM data. Every dimension must still come from the inputs below. Never invent a value. Where this prompt allows an approximation, it is listed explicitly and must be tagged `preview-only` in extras and in the report.

Work only in `C:\Users\VICTUS\Desktop\Daivinci\window\POC`. Do not modify anything under `configurator/`.

## Inputs (all read-only)

| file | what it is |
|---|---|
| `<CASEMENT_DWG>` (e.g. `Casement_and_Fixed_-_PVC_-_3.25.dwg`) | profile sections and elevations, inches (`INSUNITS = 1`) |
| `<FABRICATION_PDF>` (e.g. `Casement_and_Awning_-_PVC_-_3.25.pdf`, Soniplastics) | hardware application sheets. **Sheet 21 (PDF p.90)** = "#50.10 operator Truth application, 3¼" casement": hinge model, hinge placement, pocket height |
| `<HINGE_PDF>` (e.g. `AT WCA 14.97 Maxim Hinges.pdf`, Truth "14.97 CUSTOMER PAGE", 1:1) | hinge track, sash arm and support arm, closed **and** open-90° views |
| `<OPERATOR_PDF>` (optional: Truth 50.10 customer page with an open view) | operator arms. If absent, skip the operator and say so |
| `glb/Window_V3.glb`, `prompts/01-glb-userdata-prompt.md` | reference format (materials, extras keys, cfg contract) |

## Outputs

1. `glb/Casement_V1.glb`: geometry, materials, hierarchy, hinge hardware, animation, provenance extras. No `cfg`.
2. `glb/Casement_V1_cfg.glb`: the same file plus `extras.cfg` and the PVC exterior/interior split.
3. Scripts: `prompts/build-casement-geometry.py` (Part A, B) and `prompts/build-casement-cfg.mjs` (Part C, D).
4. A report `prompts/casement-glb-report.md` (Part E), plus a plan-view PNG of the sill hinge at 0°/45°/90°.

## Decisions already made (do not change, do not re-ask)

| item | decision |
|---|---|
| Window type | casement, one sash, outswing |
| Unit to model | the **24 × 36 in casement elevation** at DWG x 0→24 and its sections (jamb row above it, head/sill column left of it). Ignore the fixed, twin, mullion and coupler assemblies |
| Glazing set | **7/8 in IGU**: `VERRE-875-3MM` + bead `09604XB` (not the 1-1/4 in set with `09c07`) |
| Elevation viewing side | drawn **from the exterior**: the swing-triangle apex side = hinge side, with no mirroring |
| Hinge side | **left** as seen from the exterior |
| Opens | **outward** |
| Reference size | W0 = 0.6096 m (24 in), H0 = 0.9144 m (36 in), frame outside size |
| Hinge hardware | **Truth #14.97** (concealed slider-crank washability hinge), at head and sill |
| Preview opening angle / duration | 90° / 3 s (preview-only, user 2026-11-18) |
| Jamb extension | model the PVC `01436` as `Extension_*_01436`. Leave out the wood `EXTENSION 0.705 X 4.580` (layer BOIS, no code) and report it |
| Not modelled | shims (`cale a thermo …`, layer QUINCALLERIE), screws, rivets, snubbers |
| Allowed approximations | (a) glass = one solid of IGU thickness; (b) hinge part thicknesses track 0.15 / support arm 0.14 / sash arm 0.14 in (sum = Truth end-view stack 0.43); (c) rectangular track ends; hinge shoe and stud not modelled; (d) material `Hardware_Metal` = grey, metallic 1, roughness 0.45 |

If anything you read contradicts these, **stop and report**.

## Hard rules

1. Every dimension comes from the inputs. Called-out dimensions win. Where you **measure** a vector drawing instead (pivot centres, outlines), first verify its scale against at least one called-out dimension, then cross-check the measurement against a second, independent fact. Report every measured value and its cross-check.
2. Node names use DWG block codes (`09700D`, `09601XI`, `09604XB`, `01436`) and Truth part numbers (`14.97`). Never invent codes.
3. Units are metres in the GLB (1 in = 0.0254 m exactly). Y-up.
4. DWG → DXF with LibreDWG `dwg2dxf` or ODA (build LibreDWG from GitHub source if needed; init the `jsmn` submodule). ezdxf cannot read DWG.
5. When reading mirrored inserts (`xscale = −1`), convert LWPOLYLINE points with `ezdxf.path.make_path` (handles OCS and bulges). `get_points()` returns OCS and will mirror them.
6. `cfg` is added with Node `@gltf-transform/core` + `/extensions` (install outside `configurator/`), never Blender. Booleans must be JSON booleans.
7. Never claim a check passed unless you ran it.

## Part A: profile geometry (Python: ezdxf, shapely, `triangle`, numpy)

**Coordinates** (same as V3): X = width 0→W0, Y = height 0→H0, Z = depth. Origin = bottom-left outside corner of the frame on its exterior face. Exterior face is at z = 0, exterior faces +Z, interior goes to −Z.
- Jamb section: model x = DWG x; z = DWG y − (max DWG y of the jamb frame outline).
- Head/sill section: model y = DWG y; z = DWG x − (max DWG x of the head/sill frame outline).

**Per block:** largest closed loop = outline. Loops inside it = chambers (holes). Loops outside it (touching, zero overlap) = separate gasket/tape solids → node `<member>_tape`. Drop HATCH boundaries that duplicate a polyline. Glass: the two open polylines are the lites. Their outer ends give the glass edges; their span gives the IGU thickness. Jamb and head/sill depths must agree within 1e−4 in.

**Extrusion:** one mesh per member per side, 45° mitres at the outer corners of each assembly (corner = section extents of that assembly's profile outlines; tape uses its parent's mitre planes). Triangulate caps with **constrained Delaunay, no Steiner points** (`triangle`, flags `pYQ`), not earcut: earcut leaves slivers and gaps on these profiles. Simplify rings (`simplify(0)`) first. Assert that each cap's triangle areas sum to the section area. Flat normals. POSITION/NORMAL float32, indices UNSIGNED_SHORT/INT, mode 4, 1 primitive per mesh, no mesh sharing, no compression.

Materials `PVC_White`, `Glass_IGU`, `Glazing_Tape` are copied value-for-value from `Window_V3.glb`. Add `Hardware_Metal` (approximation d).

## Part B: hinge kinematics and hardware

**Linkage (Truth 14.97 page, 1:1).** Measure from the vector geometry (circles are drawn as polyline loops: chain them and fit circles):
- shoe pivot A (on the sliding shoe), joint B (on the sash arm), fixed stud S (on the track);
- |AB| and |BS| in both the closed view and the open-90° view (they must agree within 0.001 in);
- track outline, sash-arm and support-arm widths and end positions.

Expected ≈ |AB| 4.663, |BS| 6.837, closed |AS| 11.500, shoe travel at 90° ≈ 6.50 (Truth's text says "sash moves 6-1/2 in").

**Placement (Soniplastics sheet 21, 1:2).** Verify the scale with the 23.028 in frame width. Read the stud position from the frame's outside edge on the hinge side, and the pivot-line depth from the frame exterior face. Check: S_x − |AS|closed ≈ the sash-arm pivot hole you measure there. Report the .827 in callout and whether it reconciles. Hinge pocket = sill top to sash bottom at the pivot depth (from the DWG geometry); expect 0.438 (Soniplastics .438, Truth .435 ±.008).

**Motion:** slider-crank in the XZ plane, sash angle φ = 0→90° linear in time, θ = −φ about +Y (left hinge, outward):
- shoe pivot x(φ) = S_x − (|AB|·cosφ + √(|BS|² − |AB|²·sin²φ)), z constant;
- support-arm angle α about +Y at S from the closed direction (−x): α = atan2(B_z − S_z, −(B_x − S_x)).

**Hierarchy:**
```
Scene "Scene" → Window_09700D
├─ Frame_{Bottom,Left,Right,Top}_09700D
├─ Extension_{…}_01436
├─ Hinge_{Bottom,Top}_Track_14.97                     static on frame
├─ Hinge_{Bottom,Top}_SupportArm_Pivot   T = S, rotation animated
│  └─ Hinge_{…}_SupportArm_Offset        T = −S
│     └─ Hinge_{…}_SupportArm_14.97
└─ Sash_Hinge                            T = A_closed, rotation + translation animated
   └─ Sash_HingeOffset                   T = −A_closed
      ├─ Sash_{…}_09601XI (+ _tape)
      ├─ Bead_{…}_09604XB (+ _tape)
      ├─ SashGlass
      └─ Hinge_{Bottom,Top}_SashArm_14.97
```
All other nodes have identity transforms, and geometry is baked in absolute coordinates. Hardware layers from the sill top up: track, support arm, sash arm. The head hinge mirrors the sill (y′ = 36 − y).

**Clip `Sash_Hinge`:** 31 LINEAR keys over 0–3 s, with 4 channels: `Sash_Hinge.rotation`, `Sash_Hinge.translation` (absolute pivot path) and both `SupportArm_Pivot.rotation`. Key 0 equals the node rest values exactly.

**Extras:**
- Provenance on every part: `source_file`, `source_layer`, `source_block`, `sub_piece`, `source_section`, `source_insert_xy_in`, `assembly`, `side`, `units_source`, `length_rule`. Hardware also gets `placement_source`. Add `note` wherever an approximation is used.
- Root: `window_type`, `hinge_side`, `opens`, `note`, `hinge_hardware {model, type, shoeToJoint_in, supportArm_in, stud_in, pivotClosed_in, shoeTravel_in, source, derivation, thickness_note}`.

## Part C: `extras.cfg` (Node, merge, never replace)

Same contract as `01-glb-userdata-prompt.md`.
- Parts: `davinci.window.part/1`. Split factors: left x 0/0 y 0/1; right x 1/1 y 0/1; top x 0/1 y 1/1; bottom x 0/1 y 0/0; glass x 0/1 y 0/1. Splits at 0.3048 / 0.4572. A stretching split must be ≥ 10 mm from every vertex, with vertices on both sides; otherwise stop.
- Glass and tape use assembly `Sash`.
- Profile colorZone per assembly: z_mid ≥ Z_frame → `exterior`, else `interior`.
- Hardware: `role "hardware"`, `assembly "Hinge"`, `colorZone "hardware"`, rigid (x 0/0; y 0/0 at the sill, 1/1 at the head).
- `Sash_Hinge`: `davinci.window.hinge/1`, `role "hingePivot"`, `clip`, `offsetNode`, `axis "y"`, `pivot_m`, `pivotFactor {x: 0 left / 1 right, y: 0}`, `hingeSide`, `opens`, `hingeSide_source`, `motion "slider-crank"`, `linkage {model, trackAxis, stud_m, shoeToJoint_m, supportArm_m, shoeTravelAtOpen_m, note, source}`. `Sash_HingeOffset`: `role "hingeOffset"`. Link nodes: `role "linkPivot"` / `"linkOffset"` with `pivotFactor`.
- Root: `davinci.window.cfg/1`, `windowType "casement"`, reference, axes, `colorZones`, `animations: [{clip, node, motion: "rotate+slide", axis: "y", openAngle_deg: 90, slideAxis: "x", slideTravel_m, openAngle_source, label: "Sash"}]`.

## Part D: PVC exterior/interior split

Exactly as Part B of `01-glb-userdata-prompt.md`: `PVC_Exterior` / `PVC_Interior`, face-normal rule ±0.5, triangle order kept, empty primitives dropped, `PVC_White` removed if unused. Invariants: triangle count, triangle set, bbox, vertex values.

## Part E: verification and report (report numbers)

1. Frame bbox x 0→0.6096, y 0→0.9144, max z = 0 (1e−6), plus a bbox per assembly in inches.
2. Hierarchy listing. Only the 6 hinge/link nodes have transforms. Each pivot + offset sums to exactly [0, 0, 0].
3. Every mesh is closed and consistently wound (merge vertices by position). Stop if not.
4. Split clearance per part.
5. Hinge motion:
   - free-edge midpoint z at t = 0 / 1.5 / 3 s (must move to +Z);
   - support-arm length error at keys and mid-keys;
   - joint B gap between the sash arm and the support arm;
   - support-arm angle at 90° vs Truth's open drawing.
6. Collision sweep (≥ 11 time steps, vertices plus surface samples): sash and hardware vs frame/extension, hardware vs sash. Seal (tape) overlaps already present at rest come from the drawing; report them separately.
7. cfg types and consistency (`canScale* === below !== above`, JSON booleans), and that provenance extras survived.
8. Part D triangle counts (before → exterior + interior).
9. Run `node configurator/tools/validate-glb.mjs glb/Casement_V1_cfg.glb --original glb/Casement_V1.glb` and paste the output. Expected errors: hinge/link nodes (schema), rotate animation entry (travel fields), `hardware` role/colorZone. List every error. Do not edit the validator.
10. Table of everything read or measured: source, block/layer/page, value, cross-check. Also list every approximation and everything not modelled.
11. Plan-view PNG of the sill hinge at 0° / 45° / 90°.

## Not in scope (separate configurator task)

- `schema.js`: accept `davinci.window.hinge/1` (hingePivot, hingeOffset, linkPivot, linkOffset), `role/colorZone "hardware"`, assembly `Hinge`, and animation `motion` (`rotate`, `rotate+slide`). A missing `motion` means translate.
- `WindowModel.js`: exempt hinge/link nodes from the identity check. Bind rotation and translation tracks without travel scaling. Treat the translation track as an absolute path offset by (ΔW·pivotFactor.x, ΔH·pivotFactor.y, 0). Move pivots and offsets on `setSize`.
- `explode.js`: add `Sash`, `Bead`, `Hinge`, `Sash_glass`, `Sash_gasket`.
- `validate-glb.mjs`: hinge/link schema, hardware role, and rotate/slide animation checks.
