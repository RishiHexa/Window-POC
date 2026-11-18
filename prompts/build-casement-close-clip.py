#!/usr/bin/env python3
"""Casement_V3.glb -> Casement_V4.glb: add clip "Sash_Hinge_Close" = the "Sash_Hinge" (open) clip with every
channel's output keys reversed in time. Same channels, same time inputs, LINEAR. Geometry and nodes unchanged.

  python3 build-casement-close-clip.py glb/Casement_V3.glb glb/Casement_V4.glb
"""
import sys, json, struct
import numpy as np

SRC, OUT = sys.argv[1], sys.argv[2]
b = open(SRC, 'rb').read(); L = struct.unpack('<I', b[12:16])[0]
g = json.loads(b[20:20 + L]); bl = struct.unpack('<I', b[20 + L:24 + L])[0]; bin_ = bytearray(b[28 + L:28 + L + bl])
NC = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}
def read(i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]; n = NC[a['type']]
    assert a['componentType'] == 5126 and 'byteStride' not in bv
    return np.frombuffer(bytes(bin_), np.float32, a['count'] * n, bv.get('byteOffset', 0) + a.get('byteOffset', 0)).reshape(a['count'], n)
def add(arr, typ):
    while len(bin_) % 4: bin_.append(0)
    off = len(bin_); bin_.extend(arr.tobytes())
    g['bufferViews'].append({'buffer': 0, 'byteOffset': off, 'byteLength': arr.nbytes})
    g['accessors'].append({'bufferView': len(g['bufferViews']) - 1, 'componentType': 5126, 'count': int(arr.shape[0]), 'type': typ})
    return len(g['accessors']) - 1

names = [a['name'] for a in g['animations']]
assert names == ['Sash_Hinge'], f'expected only the open clip, found {names}'
op = g['animations'][0]
cl = {'name': 'Sash_Hinge_Close', 'samplers': [], 'channels': []}
for s in op['samplers']:
    t = read(s['input'])[:, 0]
    assert np.allclose(t, t[0] + t[-1] - t[::-1]), 'key times not symmetric; cannot reuse input'
    out = read(s['output'])
    cl['samplers'].append({'input': s['input'], 'output': add(np.ascontiguousarray(out[::-1]), g['accessors'][s['output']]['type']),
                           'interpolation': s['interpolation']})
for c in op['channels']:
    cl['channels'].append({'sampler': c['sampler'], 'target': dict(c['target'])})
g['animations'].append(cl)
root = next(n for n in g['nodes'] if n['name'] == 'Window_09700D')
root['extras']['note'] += ' Clip Sash_Hinge opens (0 -> 90 deg); clip Sash_Hinge_Close is the same keys reversed (90 -> 0 deg).'
g['asset']['generator'] += ' + build-casement-close-clip.py'
while len(bin_) % 4: bin_.append(0)
g['buffers'][0]['byteLength'] = len(bin_)
js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
open(OUT, 'wb').write(struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js
                      + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_))
print('clips:', [a['name'] for a in g['animations']], 'channels each:', len(cl['channels']))
