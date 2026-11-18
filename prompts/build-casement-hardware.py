#!/usr/bin/env python3
"""Casement_V2.glb -> Casement_V3.glb: add visible Truth #14.97 hinge hardware (head and sill), animated with the linkage.

  python3 build-casement-hardware.py glb/Casement_V2.glb glb/Casement_V3.glb

Adds per hinge: track (static, on frame), sash arm (rides with the sash), support arm (own pivot node at the stud,
rotation channel added to clip Sash_Hinge). Visual preview only.

Sources (inches):
  plan outlines - Truth "14.97 CUSTOMER PAGE" (1:1 vector): track 13.00 x 0.718 (called-out 13.00 / .72);
    track spans -0.4667..+0.2513 across the pivot line; track end 11.7658 from stud; sash arm 0.50 wide
    (called-out .50), end-circle centres at shoe pivot A and A+6.972 (overall 7.47, retail "7-3/8 in arms");
    support arm 0.50 wide, end centres at stud S and joint B.
  pocket - frame sill top y=0.6704, sash bottom y=1.1084 (DWG geometry), gap 0.438 (Soniplastics .438, Truth .435).
  PREVIEW APPROXIMATIONS (not in any drawing; user approved 2026-11-18): individual part thicknesses
    track 0.15 / support arm 0.14 / sash arm 0.14 (sum 0.43 = Truth end-view stack .43); rectangular track ends;
    shoe, stud, rivets, screws not modelled; material Hardware_Metal colour/metal/roughness.
"""
import sys, json, struct, math
import numpy as np
from shapely.geometry import LineString, Polygon, box
from shapely.geometry.polygon import orient
import triangle as tr

SRC, OUT = sys.argv[1], sys.argv[2]
IN = 0.0254
b = open(SRC, 'rb').read(); L = struct.unpack('<I', b[12:16])[0]
g = json.loads(b[20:20 + L]); bl = struct.unpack('<I', b[20 + L:24 + L])[0]; bin_ = bytearray(b[28 + L:28 + L + bl])
nodes = {n['name']: i for i, n in enumerate(g['nodes'])}
root = g['nodes'][nodes['Window_09700D']]; hw = root['extras']['hinge_hardware']
AB, BS = hw['shoeToJoint_in'], hw['supportArm_in']
SX, PZ = hw['stud_in'][0], hw['stud_in'][2]
A0 = hw['pivotClosed_in'][0]

# ---- read the existing clip (rotation + translation of Sash_Hinge)
def read_acc(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[a['type']]
    arr = np.frombuffer(bytes(bin_), np.float32, a['count'] * n, bv.get('byteOffset', 0) + a.get('byteOffset', 0))
    return arr.reshape(a['count'], n) if n > 1 else arr
an = g['animations'][0]
ch = {c['target']['path']: an['samplers'][c['sampler']] for c in an['channels']}
t = read_acc(ch['rotation']['input']); Q = read_acc(ch['rotation']['output']).astype(float); T = read_acc(ch['translation']['output']).astype(float)
phi = 2 * np.arcsin(-Q[:, 1])                 # sash angle (rad), theta = -phi
Ax = T[:, 0] / IN                             # shoe pivot x (in)

# ---- support-arm angle per key: closed direction S->B is -x; alpha about +Y with v = (-cos a, sin a) in (x,z)
Bx = Ax + AB * np.cos(phi); Bz = PZ + AB * np.sin(phi)
vx, vz = (Bx - SX) / BS, (Bz - PZ) / BS
assert np.allclose(np.hypot(Bx - SX, Bz - PZ), BS, atol=1e-4), 'linkage inconsistent'
alpha = np.arctan2(vz, -vx)
qs = np.c_[np.zeros_like(alpha), np.sin(alpha / 2), np.zeros_like(alpha), np.cos(alpha / 2)].astype(np.float32); qs[0] = [0, 0, 0, 1]

# ---- shapes (plan polygons in (x, z) inches, closed position)
TRACK_END = SX - 11.7658
track = box(TRACK_END, PZ - 0.4667, TRACK_END + 13.00, PZ + 0.2513)
sash_arm = LineString([(A0, PZ), (A0 + 6.972, PZ)]).buffer(0.25, quad_segs=8)
support = LineString([(SX, PZ), (A0 + AB, PZ)]).buffer(0.25, quad_segs=8)
Y_FRAME, Y_SASH = 0.6704, 1.1084
assert abs((Y_SASH - Y_FRAME) - 0.438) < 1e-4
LAYERS = {'track': (0.0, 0.15), 'support': (0.15, 0.29), 'sasharm': (0.29, 0.43)}   # preview-only split of .43 stack

def prism(poly, y0, y1):
    poly = orient(poly.simplify(1e-9), 1.0); ring = list(poly.exterior.coords)[:-1]; n = len(ring)
    res = tr.triangulate(dict(vertices=np.array(ring), segments=np.array([[i, (i + 1) % n] for i in range(n)])), 'pYQ')
    assert len(res['vertices']) == n
    P, F = [], []
    def add(pts): base = len(P); P.extend(pts); return base
    lo = add([(x, y0, z) for x, z in ring]); hi = add([(x, y1, z) for x, z in ring])
    for a_, b_, c_ in res['triangles']: F += [[lo + a_, lo + b_, lo + c_], [hi + a_, hi + c_, hi + b_]]
    for i in range(n):
        j = (i + 1) % n; q = add([(ring[i][0], y0, ring[i][1]), (ring[j][0], y0, ring[j][1]), (ring[j][0], y1, ring[j][1]), (ring[i][0], y1, ring[i][1])])
        F += [[q, q + 2, q + 1], [q, q + 3, q + 2]]
    P = np.array(P); F = np.array(F)
    v = P[F]; vol = np.einsum('ij,ij->i', v[:, 0], np.cross(v[:, 1], v[:, 2])).sum() / 6
    if vol < 0: F = F[:, ::-1]
    return P, F

def layer_y(side, key):
    a, c = LAYERS[key]
    if side == 'Bottom': return Y_FRAME + a, Y_FRAME + c
    return 36.0 - Y_FRAME - c, 36.0 - Y_FRAME - a     # head: mirror of the sill (same blocks, mirrored)

# ---- buffer helpers
def push(arr, target=None):
    while len(bin_) % 4: bin_.append(0)
    off = len(bin_); bin_.extend(arr.tobytes()); bv = {'buffer': 0, 'byteOffset': off, 'byteLength': arr.nbytes}
    if target: bv['target'] = target
    g['bufferViews'].append(bv); return len(g['bufferViews']) - 1
def acc(arr, ctype, typ, target=None, mm=False):
    a = {'bufferView': push(arr, target), 'componentType': ctype, 'count': int(arr.shape[0]), 'type': typ}
    if mm: a['min'] = arr.min(0).tolist() if arr.ndim > 1 else [float(arr.min())]; a['max'] = arr.max(0).tolist() if arr.ndim > 1 else [float(arr.max())]
    g['accessors'].append(a); return len(g['accessors']) - 1

g['materials'].append({'name': 'Hardware_Metal', 'pbrMetallicRoughness': {'baseColorFactor': [0.62, 0.63, 0.65, 1.0], 'metallicFactor': 1.0, 'roughnessFactor': 0.45},
                       'doubleSided': True, 'extras': {'note': 'preview-only appearance for hinge hardware; not from any drawing'}})
MAT = len(g['materials']) - 1
SRC_HW = 'AT WCA 14.97 Maxim Hinges.pdf (Truth 14.97 customer page, 1:1)'
def add_mesh(name, P_in, F, extras):
    Pm = (P_in * IN).astype(np.float32); tv = Pm[F]
    n = np.cross(tv[:, 1] - tv[:, 0], tv[:, 2] - tv[:, 0]); n /= np.linalg.norm(n, axis=1, keepdims=True)
    Pf = tv.reshape(-1, 3).astype(np.float32); Nf = np.repeat(n, 3, 0).astype(np.float32); I = np.arange(len(Pf), dtype=np.uint16)
    g['meshes'].append({'name': name, 'primitives': [{'attributes': {'POSITION': acc(Pf, 5126, 'VEC3', 34962, True), 'NORMAL': acc(Nf, 5126, 'VEC3', 34962)},
                                                      'indices': acc(I, 5123, 'SCALAR', 34963), 'material': MAT, 'mode': 4}]})
    g['nodes'].append({'name': name, 'mesh': len(g['meshes']) - 1, 'extras': extras}); return len(g['nodes']) - 1
def ex(side, piece, note):
    return {'source_file': SRC_HW, 'source_block': 'Truth #14.97 ' + piece, 'sub_piece': piece, 'assembly': 'Hinge', 'side': side.lower(),
            'units_source': 'inch (drawing units)', 'placement_source': 'Casement_and_Awning_-_PVC_-_3.25.pdf p.21 (1:2); hinge pocket from DWG geometry',
            'note': note}

new_root_children, new_offset_children = [], []
pivot_nodes = []
for side, part in (('Bottom', '14.97.00.203/.071 (LL)'), ('Top', '14.97.00.204/.070 (UL)')):
    y0, y1 = layer_y(side, 'track'); P, F = prism(track, y0, y1)
    new_root_children.append(add_mesh(f'Hinge_{side}_Track_14.97', P, F, ex(side, f'track {part}', 'plan outline from drawing; thickness preview-only; rectangular ends')))
    y0, y1 = layer_y(side, 'sasharm'); P, F = prism(sash_arm, y0, y1)
    new_offset_children.append(add_mesh(f'Hinge_{side}_SashArm_14.97', P, F, ex(side, f'sash arm {part}', 'outline from drawing (0.50 wide, 7.47 long); thickness preview-only; shoe not modelled')))
    y0, y1 = layer_y(side, 'support'); P, F = prism(support, y0, y1)
    m = add_mesh(f'Hinge_{side}_SupportArm_14.97', P, F, ex(side, f'support arm {part}', 'stud-to-joint 6.837, 0.50 wide; thickness preview-only'))
    S_m = [float(np.float32(SX * IN)), 0.0, float(np.float32(PZ * IN))]
    g['nodes'].append({'name': f'Hinge_{side}_SupportArm_Offset', 'translation': [-S_m[0], 0.0, -S_m[2]], 'children': [m],
                       'extras': {'note': 'cancels the support-arm pivot so the mesh keeps absolute coordinates'}})
    off = len(g['nodes']) - 1
    g['nodes'].append({'name': f'Hinge_{side}_SupportArm_Pivot', 'translation': S_m, 'children': [off],
                       'extras': {'note': 'rotates about +Y at the fixed stud S; driven by clip Sash_Hinge'}})
    piv = len(g['nodes']) - 1; pivot_nodes.append(piv); new_root_children.append(piv)
root['children'] += new_root_children
g['nodes'][nodes['Sash_HingeOffset']]['children'] += new_offset_children

# ---- add support-arm rotation channels to the same clip (same time input)
qi = acc(qs, 5126, 'VEC4')
for piv in pivot_nodes:
    an['samplers'].append({'input': ch['rotation']['input'], 'output': qi, 'interpolation': 'LINEAR'})
    an['channels'].append({'sampler': len(an['samplers']) - 1, 'target': {'node': piv, 'path': 'rotation'}})

root['extras']['hinge_hardware']['modelled_parts'] = 'track, sash arm, support arm (head and sill); shoe/stud/rivets/screws not modelled'
root['extras']['hinge_hardware']['thickness_note'] = 'part thicknesses 0.15/0.14/0.14 in are preview-only (sum = Truth end-view stack .43 in)'
g['asset']['generator'] = 'build-casement-geometry.py + build-casement-hinge.py + build-casement-hardware.py'
while len(bin_) % 4: bin_.append(0)
g['buffers'][0]['byteLength'] = len(bin_)
js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
open(OUT, 'wb').write(struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js
                      + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_))
print('support-arm angle deg at keys 0/10/20/30:', np.degrees(alpha[[0, 10, 20, 30]]).round(3).tolist())
print('track x', round(TRACK_END, 4), round(TRACK_END + 13, 4), ' z', round(PZ - 0.4667, 4), round(PZ + 0.2513, 4))
