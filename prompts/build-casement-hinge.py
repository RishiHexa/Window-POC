#!/usr/bin/env python3
"""Casement_V1.glb -> Casement_V2.glb: replace the simple fixed pivot with the Truth #14.97 hinge
(slider-crank: sash arm on a sliding shoe A, support arm from sash-arm hole B to a fixed stud S on the track).

  python3 build-casement-hinge.py glb/Casement_V1.glb glb/Casement_V2.glb

Geometry is unchanged (meshes, materials and provenance copied as-is). Only the two hinge nodes,
the root extras and the animation change. Visual preview only, not product data.

Hinge values (inches), all measured from vector drawings and cross-checked:
  Truth "14.97 CUSTOMER PAGE" (AT WCA 14.97 Maxim Hinges.pdf, scale 1:1, verified: track holes
  measure 4.0000/4.0000/3.3750 vs called-out 4.00/4.00/3.38):
    A-B (shoe pivot to support-arm joint on sash arm) = 4.6632  (closed view 4.6631, 90-deg view 4.6633)
    B-S (support arm)                                   = 6.8370  (closed view 6.8369, 90-deg view 6.8373)
    closed: A,B,S collinear, A-S = 11.5000; 90-deg: A-S = 5.0040 -> shoe travel 6.496 (Truth: "6-1/2")
  Soniplastics "Casement and Awning - PVC - 3.25.pdf", p.21 #50.10 operator Truth application (scale 1:2,
  verified: frame width measures 23.030 vs called-out 23.028):
    stud S from the frame outside edge on the hinge side = 12.4375 ; sash-arm pivot hole 0.9350 (linkage
    predicts 12.4375 - 11.5002 = 0.9373) ; pivot line depth from the frame exterior face = 1.0152
"""
import sys, json, struct, math
import numpy as np

SRC, OUT = sys.argv[1], sys.argv[2]
IN = 0.0254
AB, BS = 4.6632, 6.8370           # Truth 14.97
S_X, PIV_DEPTH = 12.4375, 1.0152  # Soniplastics p.21 placement (hinge side = model left)
OPEN_DEG, DURATION, N = 90.0, 3.0, 31   # preview-only angle/duration (user 2026-11-18); key count

b = open(SRC, 'rb').read(); L = struct.unpack('<I', b[12:16])[0]
g = json.loads(b[20:20 + L]); bl = struct.unpack('<I', b[20 + L:24 + L])[0]; bin_ = bytearray(b[28 + L:28 + L + bl])
nodes = {n['name']: i for i, n in enumerate(g['nodes'])}
root = g['nodes'][nodes['Window_09700D']]
assert root['extras']['hinge_side'] == 'left' and root['extras']['opens'] == 'outward'

def shoe_to_stud(phi):  # distance A->S along the track for sash angle phi (rad)
    return AB * math.cos(phi) + math.sqrt(BS * BS - (AB * math.sin(phi)) ** 2)
s0 = shoe_to_stud(0.0)
A0x = S_X - s0                     # closed pivot x (in)
PZ = -PIV_DEPTH                    # pivot z (in)
P0 = [A0x * IN, 0.0, PZ * IN]
P0 = [float(np.float32(v)) for v in P0]

t = np.linspace(0, DURATION, N)
phi = np.radians(OPEN_DEG) * t / DURATION
ax = np.array([S_X - shoe_to_stud(p) for p in phi]) * IN          # absolute pivot x (m)
trans = np.c_[ax, np.zeros(N), np.full(N, P0[2])].astype(np.float32)
trans[0] = P0                                                        # exact rest = node translation
theta = -phi                                                         # left hinge, outward
rot = np.c_[np.zeros(N), np.sin(theta / 2), np.zeros(N), np.cos(theta / 2)].astype(np.float32)
rot[0] = [0, 0, 0, 1]

def push(arr):
    while len(bin_) % 4: bin_.append(0)
    off = len(bin_); bin_.extend(arr.tobytes())
    g['bufferViews'].append({'buffer': 0, 'byteOffset': off, 'byteLength': arr.nbytes}); return len(g['bufferViews']) - 1
def acc(arr, typ, mm=False):
    a = {'bufferView': push(arr), 'componentType': 5126, 'count': int(arr.shape[0]), 'type': typ}
    if mm: a['min'] = [float(arr.min())]; a['max'] = [float(arr.max())]
    g['accessors'].append(a); return len(g['accessors']) - 1
ti = acc(t.astype(np.float32), 'SCALAR', True)
hi = nodes['Sash_Hinge']
g['animations'] = [{'name': 'Sash_Hinge', 'samplers': [
    {'input': ti, 'output': acc(rot, 'VEC4'), 'interpolation': 'LINEAR'},
    {'input': ti, 'output': acc(trans, 'VEC3'), 'interpolation': 'LINEAR'}],
    'channels': [{'sampler': 0, 'target': {'node': hi, 'path': 'rotation'}},
                 {'sampler': 1, 'target': {'node': hi, 'path': 'translation'}}]}]
g['nodes'][hi]['translation'] = P0
g['nodes'][nodes['Sash_HingeOffset']]['translation'] = [-P0[0], 0.0, -P0[2]]
travel = float(ax[-1] - ax[0])
root['extras']['note'] = (
    'Sash motion follows the Truth #14.97 Maxim washability hinge (slider-crank): the sash arm pivots on a shoe that '
    f'slides along the track toward the lock side while the sash rotates; shoe travel at {OPEN_DEG:g} deg = {travel/IN:.3f} in. '
    'Hinge geometry measured from the Truth 14.97 customer page (1:1) and placed per Soniplastics p.21 (1:2). '
    f'Opening angle {OPEN_DEG:g} deg and {DURATION:g} s duration are preview-only values (user 2026-11-18), not product data.')
root['extras']['hinge_hardware'] = {
    'model': 'Truth #14.97 (14.97.00.203 LL arm / 14.97.00.204 UL arm, 14.97.00.071/.070 tracks)',
    'type': 'slider-crank', 'trackAxis': 'x', 'trackSide': 'frame head and sill, hinge-pocket',
    'shoeToJoint_in': AB, 'supportArm_in': BS, 'stud_in': [S_X, None, PZ], 'pivotClosed_in': [round(A0x, 4), None, PZ],
    'shoeTravel_in': round(travel / IN, 4),
    'source': 'AT WCA 14.97 Maxim Hinges.pdf (Truth customer page, 1:1); Casement_and_Awning_-_PVC_-_3.25.pdf p.21 (Soniplastics, 1:2)',
    'derivation': 'pivot centres measured from vector geometry (not called-out dimensions); cross-checks in report'}
root['extras']['hinge_hardware']['stud_in'][1] = 0.0
root['extras']['hinge_hardware']['pivotClosed_in'][1] = 0.0
g['asset']['generator'] = 'build-casement-geometry.py + build-casement-hinge.py'
while len(bin_) % 4: bin_.append(0)
g['buffers'][0]['byteLength'] = len(bin_)
js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
out = struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js \
      + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_)
open(OUT, 'wb').write(out)
print(json.dumps({'P0_m': P0, 'P0_in': [A0x, 0, PZ], 's_closed_in': s0, 'travel_in': travel / IN,
                  'pivot_x_in_at_keys': (ax / IN).round(4).tolist()[::5]}, indent=0))
