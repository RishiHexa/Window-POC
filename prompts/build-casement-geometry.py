#!/usr/bin/env python3
"""Build glb/Casement_V1.glb (geometry, materials, hierarchy, hinge animation, provenance extras)
from the casement DWG. Visual preview only: never a source of manufacturing data.

Steps:
  1. DWG -> DXF with LibreDWG:   dwg2dxf -y -o casement.dxf "Casement_and_Fixed_-_PVC_-_3.25.dwg"
  2. python3 build-casement-geometry.py casement.dxf glb/Window_V3.glb glb/Casement_V1.glb

Decisions supplied by the user on 2026-11-18 (not readable from the DWG):
  - the elevation is drawn from the EXTERIOR -> the swing-triangle apex on drawing-left = LEFT hinge
  - the sash opens OUTWARD
  - glazing variant: 7/8 in IGU (VERRE-875-3MM) with bead 09604XB
Every dimension below comes from DWG block geometry; the only literals are selectors that pick
which section group to read (window bounds of the 24x36 casement and its sections) and unit conversion.
"""
import sys, json, struct, math
import numpy as np
import ezdxf
from ezdxf import path as dxfpath
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient
import triangle as tr

DXF, V3, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SRC_FILE = 'Casement_and_Fixed_-_PVC_-_3.25.dwg'
IN = 0.0254  # exact

doc = ezdxf.readfile(DXF)
assert doc.header.get('$INSUNITS') == 1, 'expected INSUNITS=1 (inches)'
msp = doc.modelspace()

# ---------- section selection (the 24x36 casement, 7/8 in glazing set) ----------
# jamb section: row above the elevation at x 0..24, DWG y 37..50 (the 7/8 row; the 1-1/4 row is at y>=49 and uses 09c07)
# head/sill section: column left of the elevation, DWG x -12..0 (the 7/8 column; the 1-1/4 column is at x<-12)
def in_jamb(x, y):  return -1 <= x <= 25 and 37 <= y <= 49
def in_head(x, y):  return -12 <= x <= 0 and -1 <= y <= 37

def loops_of(ins):
    out = []
    for v in ins.virtual_entities():
        t = v.dxftype()
        if t == 'LWPOLYLINE' and v.closed:
            p = dxfpath.make_path(v)
            out.append(Polygon([(q.x, q.y) for q in p.flattening(0.0005)]).buffer(0))
        elif t == 'HATCH':
            for hp in dxfpath.from_hatch(v):
                out.append(Polygon([(q.x, q.y) for q in hp.flattening(0.0005)]).buffer(0))
    # drop HATCH boundaries that duplicate a polyline
    uniq = []
    for p in out:
        if not any(p.symmetric_difference(q).area < 1e-9 for q in uniq): uniq.append(p)
    return uniq

def open_glass_edges(ins):
    """VERRE block: two open polylines = the two lites. Returns their union bbox in WCS."""
    xs, ys = [], []
    for v in ins.virtual_entities():
        if v.dxftype() == 'LWPOLYLINE' and not v.closed:
            for q in dxfpath.make_path(v).flattening(0.0005): xs.append(q.x); ys.append(q.y)
    return min(xs), max(xs), min(ys), max(ys)

def split_block(polys):
    """outline = largest loop; holes = loops inside it; separate solids = loops not inside (gaskets/tape)."""
    polys = sorted(polys, key=lambda p: -p.area)
    outer, holes, extra = polys[0], [], []
    for p in polys[1:]:
        if outer.contains(p): holes.append(p)
        else:
            assert outer.intersection(p).area < 1e-9, 'loop partially overlaps the outline'
            extra.append(p)
    for i, a in enumerate(holes):
        for b in holes[i+1:]: assert a.intersection(b).area < 1e-12, 'overlapping chambers'
    solid = Polygon(outer.exterior.coords, [h.exterior.coords for h in holes])
    assert solid.is_valid
    return solid, extra, len(holes)

inserts = []
for e in msp.query('INSERT'):
    x, y = e.dxf.insert.x, e.dxf.insert.y
    sec = 'jamb' if in_jamb(x, y) else 'head' if in_head(x, y) else None
    if sec: inserts.append((sec, e))

def code_of(name): return name.split(' ')[0]

# ---------- map DWG section coords -> model coords (inches) ----------
# jamb: model x = DWG x ; depth z = DWG y - Zj   (exterior face of frame = max DWG y of frame)
# head/sill: model y = DWG y ; depth z = DWG x - Zh (exterior face of frame = max DWG x of frame)
frame_j = [e for s, e in inserts if s == 'jamb' and code_of(e.dxf.name) == '09700D']
frame_h = [e for s, e in inserts if s == 'head' and code_of(e.dxf.name) == '09700D']
assert len(frame_j) == 2 and len(frame_h) == 2
Zj = max(max(p.bounds[3] for p in loops_of(e)) for e in frame_j)
Zh = max(max(p.bounds[2] for p in loops_of(e)) for e in frame_h)

def to_uz(sec, poly):
    """section polygon -> (u, z) where u = model x (jamb) or model y (head/sill)."""
    def f(c):
        return [(x, y - Zj) for x, y in c] if sec == 'jamb' else [(y, x - Zh) for x, y in c]
    return Polygon(f(poly.exterior.coords), [f(i.coords) for i in poly.interiors])

# ---------- collect members ----------
ROLE = {'09700D': ('Frame', 'profile'), '09601XI': ('Sash', 'profile'),
        '09604XB': ('Bead', 'profile'), '01436': ('Extension', 'profile')}
SKIPPED = []
members = []   # dict(assembly, side, code, block, layer, section, insert, solid, extras)
glass_j, glass_h = [], []
for sec, e in inserts:
    name, code = e.dxf.name, code_of(e.dxf.name)
    if code.startswith('VERRE'):
        (glass_j if sec == 'jamb' else glass_h).append(e); continue
    if code not in ROLE:
        SKIPPED.append((sec, name, e.dxf.layer, [e.dxf.insert.x, e.dxf.insert.y])); continue
    asm, role = ROLE[code]
    solid, extra, nholes = split_block(loops_of(e))
    s = to_uz(sec, solid); ex = [to_uz(sec, p) for p in extra]
    if sec == 'jamb':
        side = 'Left' if s.centroid.x < 12 else 'Right'   # 12 in = centre of the 24 in elevation (selector)
    else:
        side = 'Bottom' if s.centroid.x < 18 else 'Top'    # 18 in = centre of the 36 in elevation (selector)
    members.append(dict(assembly=asm, side=side, code=code, block=name, layer=e.dxf.layer,
                        section=sec, insert=[round(e.dxf.insert.x, 4), round(e.dxf.insert.y, 4)],
                        solid=s, extra=ex, nholes=nholes))

# one member per assembly per side
seen = {}
for m in members:
    k = (m['assembly'], m['side']); assert k not in seen, f'duplicate {k}'; seen[k] = m
for a in ('Frame', 'Sash', 'Bead', 'Extension'):
    for sd in ('Left', 'Right', 'Top', 'Bottom'): assert (a, sd) in seen, f'missing {a} {sd}'

# ---------- assembly outer corners (from section extents of the profile outlines) ----------
corner = {}
for a in ('Frame', 'Sash', 'Bead', 'Extension'):
    L, R, T, B = (seen[(a, s)]['solid'].bounds for s in ('Left', 'Right', 'Top', 'Bottom'))
    corner[a] = dict(x0=L[0], x1=R[2], y0=B[0], y1=T[2])

# ---------- glass ----------
gj = [open_glass_edges(e) for e in glass_j]; gh = [open_glass_edges(e) for e in glass_h]
assert len(gj) == 2 and len(gh) == 2
# jamb: glass edge = the lite end nearest the frame; other end is the section cut-off
gl = min(gj, key=lambda b: b[0]); gr = max(gj, key=lambda b: b[1])
gb = min(gh, key=lambda b: b[2]); gt = max(gh, key=lambda b: b[3])
G = dict(x0=gl[0], x1=gr[1], y0=gb[2], y1=gt[3])
zj = sorted({round(b[2] - Zj, 6) for b in gj} | {round(b[3] - Zj, 6) for b in gj})
zh = sorted({round(b[0] - Zh, 6) for b in gh} | {round(b[1] - Zh, 6) for b in gh})
assert len(zj) == 2 and len(zh) == 2 and max(abs(a - b) for a, b in zip(zj, zh)) < 1e-4, f'glass depth differs between sections {zj} {zh}'
G['z0'], G['z1'] = zj[0], zj[-1]          # jamb values; head/sill agree within 1e-4 in (reported)
G['z_headsill'] = zh
G['thk'] = G['z1'] - G['z0']

# ---------- mitred extrusion ----------
def ring_list(poly):
    # remove repeated and exactly collinear points (shape unchanged); avoids zero-area triangles
    poly = poly.simplify(0, preserve_topology=True)
    assert poly.is_valid
    poly = orient(poly, 1.0)  # exterior CCW, holes CW
    rings = [list(poly.exterior.coords)[:-1]] + [list(r.coords)[:-1] for r in poly.interiors]
    return rings

def extrude(poly, side, c):
    """poly in (u,z). Returns (positions[N,3], triangles[M,3]) in inches, closed solid."""
    def place(u, z, end):  # end 0 = low end along the member, 1 = high end
        if side in ('Left', 'Right'):
            d = (u - c['x0']) if side == 'Left' else (c['x1'] - u)
            a = c['y0'] + d if end == 0 else c['y1'] - d
            return (u, a, z)
        d = (u - c['y0']) if side == 'Bottom' else (c['y1'] - u)
        a = c['x0'] + d if end == 0 else c['x1'] - d
        return (a, u, z)
    rings = ring_list(poly)
    flat = [p for r in rings for p in r]
    # constrained Delaunay ('p'), no Steiner points ('Y'): every input vertex kept, none added
    segs, off = [], 0
    for r in rings:
        n = len(r); segs += [[off + i, off + (i + 1) % n] for i in range(n)]; off += n
    holes = [Polygon(r).representative_point().coords[0] for r in rings[1:]]
    A = dict(vertices=np.array(flat, dtype=np.float64), segments=np.array(segs))
    if holes: A['holes'] = np.array(holes)
    res = tr.triangulate(A, 'pYQ')
    assert len(res['vertices']) == len(flat) and np.allclose(res['vertices'], flat), 'triangulator added points'
    tri = res['triangles']
    v = np.array(flat)[tri]
    sa = ((v[:,1,0]-v[:,0,0])*(v[:,2,1]-v[:,0,1])-(v[:,1,1]-v[:,0,1])*(v[:,2,0]-v[:,0,0])) / 2
    assert abs(np.abs(sa).sum() - poly.area) < 1e-9 and (sa > 0).all(), 'cap triangulation does not tile the section'
    assert len(tri) == len(flat) + 2 * (len(rings) - 1) - 2, 'unexpected triangle count'
    pos, tris = [], []
    def add(pts):
        base = len(pos); pos.extend(pts); return base
    a0 = add([place(u, z, 0) for u, z in flat])
    a1 = add([place(u, z, 1) for u, z in flat])
    for t in tri:
        tris.append([a0 + t[0], a0 + t[2], a0 + t[1]])
        tris.append([a1 + t[0], a1 + t[1], a1 + t[2]])
    off = 0
    for r in rings:
        n = len(r)
        for i in range(n):
            j = (i + 1) % n
            p = [place(*r[i], 0), place(*r[j], 0), place(*r[j], 1), place(*r[i], 1)]
            b = add(p)
            tris.append([b, b + 1, b + 2]); tris.append([b, b + 2, b + 3])
        off += n
    P = np.array(pos); T = np.array(tris)
    # orient outward (whole solid flipped together, so consistency is preserved)
    v = P[T]; vol = np.einsum('ij,ij->i', v[:, 0], np.cross(v[:, 1], v[:, 2])).sum() / 6
    if vol < 0: T = T[:, ::-1]
    return P, T

def box(x0, x1, y0, y1, z0, z1):
    P, T = [], []
    faces = [((x0,y0,z0),(x0,y1,z0),(x1,y1,z0),(x1,y0,z0)), ((x0,y0,z1),(x1,y0,z1),(x1,y1,z1),(x0,y1,z1)),
             ((x0,y0,z0),(x1,y0,z0),(x1,y0,z1),(x0,y0,z1)), ((x0,y1,z0),(x0,y1,z1),(x1,y1,z1),(x1,y1,z0)),
             ((x0,y0,z0),(x0,y0,z1),(x0,y1,z1),(x0,y1,z0)), ((x1,y0,z0),(x1,y1,z0),(x1,y1,z1),(x1,y0,z1))]
    for f in faces:
        b = len(P); P.extend(f); T += [[b, b+1, b+2], [b, b+2, b+3]]
    return np.array(P), np.array(T)

# ---------- parts ----------
SIDE_L = {'Left': 'left', 'Right': 'right', 'Top': 'top', 'Bottom': 'bottom'}
SECTION = {'jamb': 'jamb section', 'head': 'vertical section (head/sill)'}
LENGTH_RULE = '45-degree mitre at assembly outer corners (from section extents)'
parts = []  # dict(name, parent, material, P(in), T, extras)
def base_extras(m, sub):
    return {'source_file': SRC_FILE, 'source_layer': m['layer'], 'source_block': m['block'], 'sub_piece': sub,
            'source_section': SECTION[m['section']], 'source_insert_xy_in': m['insert'],
            'assembly': m['assembly'], 'side': SIDE_L[m['side']], 'units_source': 'inch (INSUNITS=1)',
            'length_rule': LENGTH_RULE}
ORDER = ['Frame', 'Extension', 'Sash', 'Bead']
for a in ORDER:
    for sd in ('Bottom', 'Left', 'Right', 'Top'):
        m = seen[(a, sd)]
        P, T = extrude(m['solid'], sd, corner[a])
        name = f"{a}_{sd}_{m['code']}"
        parent = 'Sash_HingeOffset' if a in ('Sash', 'Bead') else 'ROOT'
        parts.append(dict(name=name, parent=parent, material='PVC_White', P=P, T=T,
                          extras=base_extras(m, 'profile body (chambers kept as holes)'), nholes=m['nholes']))
        if m['extra']:
            Ps, Ts, off = [], [], 0
            for g in m['extra']:
                p, t = extrude(g, sd, corner[a]); Ps.append(p); Ts.append(t + off); off += len(p)
            parts.append(dict(name=name + '_tape', parent=parent, material='Glazing_Tape',
                              P=np.vstack(Ps), T=np.vstack(Ts), npieces=len(m['extra']),
                              extras=base_extras(m, f"gaskets/glazing tape ({len(m['extra'])} separate solids inside block, outside the profile outline)")))
gm = sorted(glass_j + glass_h, key=lambda e: e.dxf.insert.x)
P, T = box(G['x0'], G['x1'], G['y0'], G['y1'], G['z0'], G['z1'])
parts.append(dict(name='SashGlass', parent='Sash_HingeOffset', material='Glass_IGU', P=P, T=T, extras={
    'source_file': SRC_FILE, 'source_layer': glass_j[0].dxf.layer, 'source_block': glass_j[0].dxf.name,
    'sub_piece': 'insulated glass unit (simplified solid)', 'source_section': 'jamb section + vertical section (head/sill)',
    'source_insert_xy_in': [[round(e.dxf.insert.x, 4), round(e.dxf.insert.y, 4)] for e in glass_j + glass_h],
    'assembly': 'Sash', 'side': 'infill', 'units_source': 'inch (INSUNITS=1)',
    'length_rule': 'glass edges from the lite end points in jamb and head/sill sections',
    'note': f"Simplified as one solid {G['thk']:.3f}in unit (two 3mm lites + spacer merged); extents from glass edges in both sections"}))

# to metres
for p in parts: p['Pm'] = (p['P'] * IN)

# ---------- pivot ----------
sash_pts = np.vstack([p['Pm'] for p in parts if p['name'].startswith('Sash_')])
HINGE, OPENS = 'left', 'outward'
Px = sash_pts[:, 0].min() if HINGE == 'left' else sash_pts[:, 0].max()
Pz = sash_pts[:, 2].max() if OPENS == 'outward' else sash_pts[:, 2].min()
PIVOT = [float(np.float32(Px)), 0.0, float(np.float32(Pz))]
theta = -math.pi / 2 if (HINGE == 'left') == (OPENS == 'outward') else math.pi / 2
QOPEN = [0.0, math.sin(theta / 2), 0.0, math.cos(theta / 2)]

# ---------- GLB writer ----------
v3b = open(V3, 'rb').read(); L = struct.unpack('<I', v3b[12:16])[0]; v3 = json.loads(v3b[20:20 + L])
mats = [m for name in ('PVC_White', 'Glass_IGU', 'Glazing_Tape') for m in v3['materials'] if m['name'] == name]
assert len(mats) == 3
MAT = {m['name']: i for i, m in enumerate(mats)}
bin_ = bytearray(); bviews, accs = [], []
def push(arr, target=None):
    while len(bin_) % 4: bin_.append(0)
    off = len(bin_); b = arr.tobytes(); bin_.extend(b)
    bv = {'buffer': 0, 'byteOffset': off, 'byteLength': len(b)}
    if target: bv['target'] = target
    bviews.append(bv); return len(bviews) - 1
def acc(arr, ctype, typ, target=None, minmax=False):
    a = {'bufferView': push(arr, target), 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
    if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a); return len(accs) - 1

nodes, meshes = [], []
idx = {}
def node(name, **kw):
    nodes.append(dict(name=name, **kw)); idx[name] = len(nodes) - 1; return idx[name]
for p in parts:
    P = p['Pm'].astype(np.float32); T = p['T']
    tv = P[T]; n = np.cross(tv[:, 1] - tv[:, 0], tv[:, 2] - tv[:, 0]); n /= np.linalg.norm(n, axis=1, keepdims=True)
    # flat normals: un-share vertices so each triangle carries its own face normal
    Pf = tv.reshape(-1, 3).astype(np.float32); Nf = np.repeat(n, 3, axis=0).astype(np.float32)
    If = np.arange(len(Pf), dtype=np.uint32 if len(Pf) > 65535 else np.uint16)
    prim = {'attributes': {'POSITION': acc(Pf, 5126, 'VEC3', 34962, True), 'NORMAL': acc(Nf, 5126, 'VEC3', 34962)},
            'indices': acc(If, 5125 if If.dtype == np.uint32 else 5123, 'SCALAR', 34963), 'material': MAT[p['material']], 'mode': 4}
    meshes.append({'name': p['name'], 'primitives': [prim]})
    node(p['name'], mesh=len(meshes) - 1, extras=p['extras'])
offset_children = [idx[p['name']] for p in parts if p['parent'] == 'Sash_HingeOffset']
node('Sash_HingeOffset', translation=[-PIVOT[0], -0.0, -PIVOT[2]], children=offset_children)
node('Sash_Hinge', translation=PIVOT, children=[idx['Sash_HingeOffset']])
root_children = [idx[p['name']] for p in parts if p['parent'] == 'ROOT'] + [idx['Sash_Hinge']]
node('Window_09700D', children=root_children, extras={
    'source_file': SRC_FILE, 'window_type': 'casement', 'hinge_side': HINGE, 'opens': OPENS,
    'note': 'Preview pivot: sash rotates about a fixed vertical axis at P. Real casement hardware (four-bar / friction stay) '
            'translates the sash while opening; that motion is not modelled. Opening angle 90 deg and 3 s duration are '
            'preview-only values (user 2026-11-18), not product data.'})
# fix -0.0 -> 0
nodes[idx['Sash_HingeOffset']]['translation'] = [-PIVOT[0], 0.0, -PIVOT[2]]
t_in = acc(np.array([0.0, 3.0], dtype=np.float32), 5126, 'SCALAR', None, True)
t_out = acc(np.array([[0, 0, 0, 1], QOPEN], dtype=np.float32), 5126, 'VEC4')
anim = {'name': 'Sash_Hinge', 'samplers': [{'input': t_in, 'output': t_out, 'interpolation': 'LINEAR'}],
        'channels': [{'sampler': 0, 'target': {'node': idx['Sash_Hinge'], 'path': 'rotation'}}]}
while len(bin_) % 4: bin_.append(0)
gltf = {'asset': {'version': '2.0', 'generator': 'build-casement-geometry.py (ezdxf + numpy)'},
        'extensionsUsed': sorted({k for m in mats for k in m.get('extensions', {})}),
        'scene': 0, 'scenes': [{'name': 'Scene', 'nodes': [idx['Window_09700D']]}],
        'nodes': nodes, 'meshes': meshes, 'materials': mats, 'accessors': accs, 'bufferViews': bviews,
        'buffers': [{'byteLength': len(bin_)}], 'animations': [anim]}
js = json.dumps(gltf, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bin_))
glb += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_)
open(OUT, 'wb').write(glb)

# ---------- sidecar for the report ----------
json.dump({'Zj_dwg_y': Zj, 'Zh_dwg_x': Zh, 'corners_in': corner, 'glass_in': G, 'pivot_m': PIVOT, 'q_open': QOPEN,
           'skipped_inserts': SKIPPED,
           'parts': [{'name': p['name'], 'tris': int(len(p['T'])), 'holes': p.get('nholes'), 'pieces': p.get('npieces'),
                      'bbox_in': [p['P'].min(0).tolist(), p['P'].max(0).tolist()]} for p in parts]},
          open(OUT + '.build.json', 'w'), indent=1)
print('wrote', OUT, len(parts), 'mesh parts; pivot', PIVOT, 'q', QOPEN)
