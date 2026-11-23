// Fine surface detail for the PVC: a small height map (normal perturbation) and roughness variation, so large profile
// faces do not render as perfectly smooth, uniform planes.
//
// PRESENTATION ONLY. Nothing here changes geometry, dimensions, colours or any stored value. The GLBs have no UVs, so
// the texture is projected in the shader from the three model-space axes (triplanar). Model space is the parts' own
// reference coordinates in metres, so the grain has the same physical size at every window size and does not stretch
// when a part is lengthened. All values in SURFACE_DETAIL are visual tuning, not product finish data.

import * as THREE from 'three';

// ---- POC-only visual tuning (NOT product finish data) ---------------------------------------------
export const SURFACE_DETAIL = {
  tile_m: 0.06,           // one texture tile covers 60 mm of surface
  bumpHeight_m: 0.00005,  // peak-to-peak height of the grain (50 µm): a light "orange peel"; 90 µm read as sandpaper on white
  roughnessVariation: 0.35, // ± fraction of the material's roughness, in broad patches
  size: 256,              // texture size (px), power of two for mipmaps
};
// ----------------------------------------------------------------------------------------------------

// Deterministic pseudo-random, so the pattern is identical on every load.
const rng = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** Tileable value noise: `cells` lattice cells across the texture, smooth (quintic) interpolation, in [0, 1]. */
function periodicNoise(size, cells, rand) {
  const lat = Float32Array.from({ length: cells * cells }, rand);
  const at = (i, j) => lat[((j % cells) * cells) + (i % cells)];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells, j = Math.floor(fy), ty = fade(fy - j);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells, i = Math.floor(fx), tx = fade(fx - i);
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
      const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
      out[y * size + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Fractal sum of `octaves` noise layers starting at `baseCells`, normalised to [0, 1]. Tileable. */
function fbm(size, baseCells, octaves, seed) {
  const rand = rng(seed);
  const sum = new Float32Array(size * size);
  let amp = 1, cells = baseCells;
  for (let o = 0; o < octaves; o++, amp *= 0.5, cells *= 2) {
    const n = periodicNoise(size, cells, rand);
    for (let k = 0; k < sum.length; k++) sum[k] += n[k] * amp;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of sum) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let k = 0; k < sum.length; k++) sum[k] = (sum[k] - lo) / (hi - lo);
  return sum;
}

/** RGBA8 data: R = fine grain height, G = broad roughness patches. Pure (no WebGL), so it is testable in Node. */
export function surfaceDetailData(size = SURFACE_DETAIL.size) {
  const height = fbm(size, 24, 4, 1234);
  const rough = fbm(size, 4, 3, 5678);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    data[k * 4] = Math.round(height[k] * 255);
    data[k * 4 + 1] = Math.round(rough[k] * 255);
    data[k * 4 + 3] = 255;
  }
  return data;
}

let texture = null;
function detailTexture() {
  if (texture) return texture;
  const size = SURFACE_DETAIL.size;
  texture = new THREE.DataTexture(surfaceDetailData(size), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace; // data, not colour
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter; // the grain averages out with distance instead of sparkling
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

// Shared by every material, so one change retunes all windows (live, no recompile).
export const surfaceDetailUniforms = {
  sdMap: { value: null },
  sdTile: { value: SURFACE_DETAIL.tile_m },
  sdHeight: { value: SURFACE_DETAIL.bumpHeight_m },
  sdRough: { value: SURFACE_DETAIL.roughnessVariation },
};

const VERT_PARS = /* glsl */ `
varying vec3 vSdPos;
varying vec3 vSdNrm;`;
const VERT_MAIN = /* glsl */ `
vSdPos = transformed;
vSdNrm = objectNormal;`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D sdMap;
uniform float sdTile;
uniform float sdHeight;
uniform float sdRough;
varying vec3 vSdPos;
varying vec3 vSdNrm;
vec3 sdWeights( vec3 n ) {
  vec3 w = pow( abs( n ), vec3( 4.0 ) );
  return w / max( w.x + w.y + w.z, 1e-5 );
}
vec4 sdSample( vec3 p, vec3 w ) {
  return texture2D( sdMap, p.yz / sdTile ) * w.x + texture2D( sdMap, p.xz / sdTile ) * w.y + texture2D( sdMap, p.xy / sdTile ) * w.z;
}
// Bump perturbation with screen-space derivatives (three.js perturbNormalArb, without normalising the position
// derivatives, so the height is in metres and the effect keeps its physical size at any zoom).
vec3 sdPerturbNormal( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir ) {
  vec3 vSigmaX = dFdx( surf_pos );
  vec3 vSigmaY = dFdy( surf_pos );
  vec3 R1 = cross( vSigmaY, surf_norm );
  vec3 R2 = cross( surf_norm, vSigmaX );
  float fDet = dot( vSigmaX, R1 ) * faceDir;
  vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
  return normalize( abs( fDet ) * surf_norm - vGrad );
}`;
const FRAG_ROUGH = /* glsl */ `
vec3 sdW = sdWeights( vSdNrm );
vec4 sdS = sdSample( vSdPos, sdW );
roughnessFactor = clamp( roughnessFactor * ( 1.0 + sdRough * ( sdS.g * 2.0 - 1.0 ) ), 0.04, 1.0 );`;
const FRAG_NORMAL = /* glsl */ `
{
  // Height at this pixel and one pixel right / up, from the same projection (as three.js' bump map does).
  float sdH0 = sdS.r;
  float sdHx = sdSample( vSdPos + dFdx( vSdPos ), sdW ).r;
  float sdHy = sdSample( vSdPos + dFdy( vSdPos ), sdW ).r;
  normal = sdPerturbNormal( -vViewPosition, normal, sdHeight * vec2( sdHx - sdH0, sdHy - sdH0 ), faceDirection );
}`;

/**
 * Add the surface detail to a MeshStandard/PhysicalMaterial (idempotent). Only the shader changes: the material's
 * colour, roughness value and every other property stay as they are.
 */
export function applySurfaceDetail(material) {
  if (material.userData.surfaceDetail) return;
  material.userData.surfaceDetail = true;
  surfaceDetailUniforms.sdMap.value = detailTexture();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, surfaceDetailUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_PARS}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${FRAG_ROUGH}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>${FRAG_NORMAL}`);
  };
  material.customProgramCacheKey = () => 'davinci-surface-detail-1';
  material.needsUpdate = true;
}
