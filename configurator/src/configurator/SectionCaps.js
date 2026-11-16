// Section view: clipping planes plus stencil-buffer caps, so cut profiles render as solid faces
// with their chambers visible. This is the technique of three.js' webgl_clipping_stencil example.
//
// For every plane P and every cap group G (PVC / glass / gasket):
//   1. Draw G's back faces (+1) and front faces (−1) into the stencil, clipped by P only.
//      A pixel ends up non-zero where plane P passes through the inside of a closed solid.
//   2. Draw a big quad on P (clipped by the other planes) where stencil ≠ 0, then reset the stencil.
// This needs closed, consistently wound solids. That was checked for every part of Window_V3_cfg.glb.
// The helpers share each mesh's geometry and are children of the mesh, so they follow the resize,
// explode and sash animation automatically.

import * as THREE from 'three';

export const LAYER_HELPERS = 2; // excluded from the AO normal pass

const STENCIL_BASE = (() => {
  const m = new THREE.MeshBasicMaterial();
  m.depthWrite = false;
  m.depthTest = false;
  m.colorWrite = false;
  m.stencilWrite = true;
  m.stencilFunc = THREE.AlwaysStencilFunc;
  return m;
})();

function stencilMaterial(plane, side, op) {
  const m = STENCIL_BASE.clone();
  m.side = side;
  m.clippingPlanes = [plane];
  m.stencilFail = op;
  m.stencilZFail = op;
  m.stencilZPass = op;
  return m;
}

export class SectionCaps {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Plane[]} planes  all section planes (active or not)
   * @param {{key:string, color:THREE.ColorRepresentation, roughness?:number, meshes:THREE.Mesh[]}[]} groups
   */
  constructor(scene, planes, groups) {
    this.scene = scene;
    this.planes = planes;
    this.helpers = [];   // { mesh, planeIndex }
    this.caps = [];      // { quad, planeIndex }
    this.capMaterials = {};
    const capGeom = new THREE.PlaneGeometry(20, 20);
    let order = 1;

    planes.forEach((plane, pi) => {
      for (const g of groups) {
        const back = stencilMaterial(plane, THREE.BackSide, THREE.IncrementWrapStencilOp);
        const front = stencilMaterial(plane, THREE.FrontSide, THREE.DecrementWrapStencilOp);
        for (const src of g.meshes) {
          for (const mat of [back, front]) {
            const h = new THREE.Mesh(src.geometry, mat);
            h.renderOrder = order;
            h.layers.set(LAYER_HELPERS);
            h.castShadow = h.receiveShadow = false;
            h.visible = false;
            h.userData.sectionHelper = true;
            src.add(h);
            this.helpers.push({ mesh: h, planeIndex: pi });
          }
        }
        const capMat = new THREE.MeshStandardMaterial({
          color: g.color,
          roughness: g.roughness ?? 0.6,
          metalness: 0,
          stencilWrite: true,
          stencilRef: 0,
          stencilFunc: THREE.NotEqualStencilFunc,
          stencilFail: THREE.ReplaceStencilOp,
          stencilZFail: THREE.ReplaceStencilOp,
          stencilZPass: THREE.ReplaceStencilOp,
        });
        (this.capMaterials[g.key] ??= []).push(capMat);
        const quad = new THREE.Mesh(capGeom, capMat);
        quad.renderOrder = order + 0.1;
        quad.layers.set(LAYER_HELPERS);
        quad.visible = false;
        quad.onAfterRender = (renderer) => renderer.clearStencil();
        scene.add(quad);
        this.caps.push({ quad, planeIndex: pi });
        order += 1;
      }
    });
    this.maxOrder = order;
  }

  /** @param {boolean[]} active  which planes are in use */
  update(active) {
    const activePlanes = this.planes.filter((_, i) => active[i]);
    for (const h of this.helpers) h.mesh.visible = active[h.planeIndex];
    for (const c of this.caps) {
      const on = active[c.planeIndex];
      c.quad.visible = on;
      if (!on) continue;
      const plane = this.planes[c.planeIndex];
      // Cap is clipped by the *other* active planes (gives the L-shaped corner cut).
      c.quad.material.clippingPlanes = activePlanes.filter((p) => p !== plane);
      plane.coplanarPoint(c.quad.position);
      c.quad.lookAt(c.quad.position.x - plane.normal.x, c.quad.position.y - plane.normal.y, c.quad.position.z - plane.normal.z);
    }
  }

  setColor(key, color) { (this.capMaterials[key] || []).forEach((m) => m.color.set(color)); }

  dispose() {
    for (const h of this.helpers) { h.mesh.parent?.remove(h.mesh); h.mesh.material.dispose(); }
    for (const c of this.caps) { this.scene.remove(c.quad); c.quad.material.dispose(); }
    this.caps[0]?.quad.geometry.dispose();
  }
}
