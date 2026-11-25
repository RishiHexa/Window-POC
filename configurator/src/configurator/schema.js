// Contract for the `extras.cfg` userData written into Window_V3_cfg.glb and Casement_V*_cfg.glb.
// Pure JS (no three.js) so it can be shared by the browser app and the Node validator.
// See ../../../prompts/01-glb-userdata-prompt.md (parts, root) and 02-casement-glb-prompt.md (hinge,
// rotate animations) for the authoritative description. Everything casement-specific is additive:
// a root animation without `motion` still means "translate" and is validated exactly as before.

export const ROOT_SCHEMA = 'davinci.window.cfg/1';
export const PART_SCHEMA = 'davinci.window.part/1';
export const GROUP_SCHEMA = 'davinci.window.group/1';
export const HINGE_SCHEMA = 'davinci.window.hinge/1';

// 'hardware' (hinge track/arms, Casement_V3+) is rigid, keeps its own GLB material and is never recoloured.
export const PART_ROLES = ['profile', 'gasket', 'glass', 'hardware'];
export const COLOR_ZONES = ['exterior', 'interior', 'glass', 'gasket', 'hardware'];
export const COLOURABLE_ZONES = ['exterior', 'interior'];

// Hinge nodes come in pivot/offset pairs. The pivot carries translation P (and the animated rotation),
// its child offset carries -P, so meshes below keep absolute reference coordinates.
export const HINGE_PIVOT_ROLES = ['hingePivot', 'linkPivot'];
export const HINGE_OFFSET_ROLES = ['hingeOffset', 'linkOffset'];
export const HINGE_MOTIONS = ['rotate', 'slider-crank'];
// Hinge axes. "y" = vertical (casement, Casement_V1+). "x" = horizontal (awning hinged at the head, hopper at the sill),
// added 2026-11-24. The hinge side must lie on that axis: a vertical axis is on a jamb, a horizontal one on head or sill.
export const HINGE_AXES = ['y', 'x'];
export const HINGE_SIDES = { y: ['left', 'right'], x: ['top', 'bottom'] };

/**
 * Error text if a quaternion track's keys ([x, y, z, w] per key) rotate about anything other than `axis`, else null.
 * A rotation about one principal axis has zero in the other two vector components.
 */
export function quaternionAxisError(values, axis, tol = 1e-6) {
  const k = { x: 0, y: 1, z: 2 }[axis];
  for (let i = 0; i + 3 < values.length; i += 4) {
    for (let j = 0; j < 3; j++) {
      if (j !== k && Math.abs(values[i + j]) > tol) {
        return `key ${i / 4} does not rotate about the ${axis} axis (q = [${Array.from(values.slice(i, i + 4), (v) => +v.toFixed(6)).join(', ')}])`;
      }
    }
  }
  return null;
}

// Root animation entries. Missing `motion` = 'translate' (Window_V3 behaviour).
export const ANIMATION_MOTIONS = ['translate', 'rotate', 'rotate+slide'];
export const animationMotion = (a) => a?.motion ?? 'translate';
// Missing `direction` = 'open' (rest pose at the first key). 'close' = rest pose at the last key.
export const ANIMATION_DIRECTIONS = ['open', 'close'];
export const animationDirection = (a) => a?.direction ?? 'open';

/**
 * Rotation angle (degrees, >= 0) of the open pose in a hinge clip's quaternion keys ([x, y, z, w] per key): the last key
 * of an opening clip, the first key of a closing clip. Root `openAngle_deg` is this angle's magnitude; its sign is
 * ignored (Casement_V* store +90, AwningWindow_3_25 stores -57). The swing direction comes from the hinge's `opens`.
 */
export function openPoseAngleDeg(values, direction) {
  const k = direction === 'close' ? 0 : values.length - 4;
  return (2 * Math.acos(Math.min(1, Math.abs(values[k + 3]))) * 180) / Math.PI;
}
/** Allowed difference between |openAngle_deg| and the clip's open pose (stored values differ by < 1e-5°). */
export const OPEN_ANGLE_TOL_DEG = 0.01;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function validateAxis(where, axis, flag) {
  const errs = [];
  if (!axis || typeof axis !== 'object') return [`${where}: missing axis object`];
  if (!isNum(axis.split_m)) errs.push(`${where}.split_m must be a number`);
  if (!isNum(axis.below)) errs.push(`${where}.below must be a number`);
  if (!isNum(axis.above)) errs.push(`${where}.above must be a number`);
  if (typeof flag !== 'boolean') errs.push(`${where}: canScale flag must be a JSON boolean (got ${JSON.stringify(flag)})`);
  else if (isNum(axis.below) && isNum(axis.above) && flag !== (axis.below !== axis.above)) {
    errs.push(`${where}: canScale=${flag} contradicts below=${axis.below}/above=${axis.above}`);
  }
  return errs;
}

/** @returns {string[]} errors */
export function validatePartCfg(name, cfg) {
  if (!cfg) return [`${name}: missing extras.cfg`];
  const errs = [];
  if (cfg.schema !== PART_SCHEMA) errs.push(`${name}: schema must be "${PART_SCHEMA}" (got ${JSON.stringify(cfg.schema)})`);
  if (!PART_ROLES.includes(cfg.role)) errs.push(`${name}: role must be one of ${PART_ROLES.join('|')}`);
  if (!COLOR_ZONES.includes(cfg.colorZone)) errs.push(`${name}: colorZone must be one of ${COLOR_ZONES.join('|')}`);
  if (cfg.role === 'profile' && !COLOURABLE_ZONES.includes(cfg.colorZone)) {
    errs.push(`${name}: profile parts need colorZone exterior|interior`);
  }
  if ((cfg.role === 'hardware') !== (cfg.colorZone === 'hardware')) {
    errs.push(`${name}: role "hardware" and colorZone "hardware" must go together`);
  }
  errs.push(...validateAxis(`${name}.x`, cfg.x, cfg.canScaleX));
  errs.push(...validateAxis(`${name}.y`, cfg.y, cfg.canScaleY));
  // Hardware has fixed dimensions: it may move with a side, but never stretch.
  if (cfg.role === 'hardware' && (cfg.canScaleX !== false || cfg.canScaleY !== false)) {
    errs.push(`${name}: hardware parts must be rigid (canScaleX and canScaleY false)`);
  }
  return errs;
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

export function validateHingeCfg(name, cfg) {
  if (!cfg) return [`${name}: missing extras.cfg`];
  const errs = [];
  if (cfg.schema !== HINGE_SCHEMA) errs.push(`${name}: schema must be "${HINGE_SCHEMA}"`);
  if (HINGE_PIVOT_ROLES.includes(cfg.role)) {
    if (typeof cfg.clip !== 'string') errs.push(`${name}: clip must be a string`);
    if (typeof cfg.offsetNode !== 'string') errs.push(`${name}: offsetNode must be a string`);
    if (!HINGE_AXES.includes(cfg.axis)) errs.push(`${name}: axis must be "y" (vertical: casement) or "x" (horizontal: awning / hopper)`);
    if (!isVec3(cfg.pivot_m)) errs.push(`${name}: pivot_m must be [x, y, z] numbers`);
    const f = cfg.pivotFactor;
    if (!f || !isNum(f.x) || !isNum(f.y)) errs.push(`${name}: pivotFactor.x and pivotFactor.y must be numbers`);
    if (cfg.role === 'hingePivot') {
      const sides = HINGE_SIDES[cfg.axis];
      if (sides && !sides.includes(cfg.hingeSide)) errs.push(`${name}: hingeSide must be ${sides.join('|')} for axis "${cfg.axis}"`);
      if (!['outward', 'inward'].includes(cfg.opens)) errs.push(`${name}: opens must be outward|inward`);
      if (cfg.motion !== undefined && !HINGE_MOTIONS.includes(cfg.motion)) errs.push(`${name}: motion must be one of ${HINGE_MOTIONS.join('|')}`);
      if (cfg.closeClip !== undefined && typeof cfg.closeClip !== 'string') errs.push(`${name}: closeClip must be a string`);
    }
  } else if (HINGE_OFFSET_ROLES.includes(cfg.role)) {
    if (typeof cfg.pivotNode !== 'string') errs.push(`${name}: pivotNode must be a string`);
  } else {
    errs.push(`${name}: hinge role must be one of ${[...HINGE_PIVOT_ROLES, ...HINGE_OFFSET_ROLES].join('|')}`);
  }
  return errs;
}

function validateAnimation(w, a) {
  const errs = [];
  if (typeof a.clip !== 'string') errs.push(`${w}.clip must be a string`);
  if (!['x', 'y', 'z'].includes(a.axis)) errs.push(`${w}.axis must be x|y|z`);
  const motion = animationMotion(a);
  if (!ANIMATION_MOTIONS.includes(motion)) return [...errs, `${w}.motion must be one of ${ANIMATION_MOTIONS.join('|')}`];
  if (motion === 'translate') {
    if (!isNum(a.referenceTravel_m) || a.referenceTravel_m === 0) errs.push(`${w}.referenceTravel_m must be a non-zero number`);
    if (!isNum(a.travelPerDeltaHeight)) errs.push(`${w}.travelPerDeltaHeight must be a number`);
    return errs;
  }
  // rotate / rotate+slide: the angle and the hardware slide do not scale with size.
  // direction "close" (Casement_V4+): the clip runs open -> rest and is named by the hinge's cfg.closeClip.
  if (typeof a.node !== 'string') errs.push(`${w}.node must be a string`);
  if (!ANIMATION_DIRECTIONS.includes(animationDirection(a))) errs.push(`${w}.direction must be one of ${ANIMATION_DIRECTIONS.join('|')}`);
  if (!isNum(a.openAngle_deg) || a.openAngle_deg === 0) errs.push(`${w}.openAngle_deg must be a non-zero number`);
  if (motion === 'rotate+slide') {
    if (!['x', 'y', 'z'].includes(a.slideAxis)) errs.push(`${w}.slideAxis must be x|y|z`);
    if (!isNum(a.slideTravel_m)) errs.push(`${w}.slideTravel_m must be a number`);
  }
  return errs;
}

export function validateGroupCfg(name, cfg) {
  if (!cfg) return [`${name}: missing extras.cfg`];
  const errs = [];
  if (cfg.schema !== GROUP_SCHEMA) errs.push(`${name}: schema must be "${GROUP_SCHEMA}"`);
  if (cfg.role !== 'motionGroup') errs.push(`${name}: role must be "motionGroup"`);
  return errs;
}

export function validateRootCfg(name, cfg) {
  if (!cfg) return [`${name}: missing extras.cfg (root)`];
  const errs = [];
  if (cfg.schema !== ROOT_SCHEMA) errs.push(`${name}: schema must be "${ROOT_SCHEMA}"`);
  if (cfg.units !== 'm') errs.push(`${name}: units must be "m"`);
  const r = cfg.reference || {};
  if (!isNum(r.width_m) || r.width_m <= 0) errs.push(`${name}: reference.width_m must be > 0`);
  if (!isNum(r.height_m) || r.height_m <= 0) errs.push(`${name}: reference.height_m must be > 0`);
  if (!Array.isArray(cfg.animations)) errs.push(`${name}: animations must be an array`);
  else cfg.animations.forEach((a, i) => errs.push(...validateAnimation(`${name}.animations[${i}]`, a)));
  return errs;
}

/** Dispatch on cfg.schema. Nodes without cfg are reported by the caller. */
export function validateNodeCfg(name, cfg) {
  switch (cfg?.schema) {
    case ROOT_SCHEMA: return validateRootCfg(name, cfg);
    case GROUP_SCHEMA: return validateGroupCfg(name, cfg);
    case HINGE_SCHEMA: return validateHingeCfg(name, cfg);
    default: return validatePartCfg(name, cfg);
  }
}
