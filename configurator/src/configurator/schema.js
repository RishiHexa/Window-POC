// Contract for the `extras.cfg` userData written into Window_V3_cfg.glb.
// Pure JS (no three.js) so it can be shared by the browser app and the Node validator.
// See ../../../prompts/01-glb-userdata-prompt.md for the authoritative description.

export const ROOT_SCHEMA = 'davinci.window.cfg/1';
export const PART_SCHEMA = 'davinci.window.part/1';
export const GROUP_SCHEMA = 'davinci.window.group/1';

export const PART_ROLES = ['profile', 'gasket', 'glass'];
export const COLOR_ZONES = ['exterior', 'interior', 'glass', 'gasket'];
export const COLOURABLE_ZONES = ['exterior', 'interior'];

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
  errs.push(...validateAxis(`${name}.x`, cfg.x, cfg.canScaleX));
  errs.push(...validateAxis(`${name}.y`, cfg.y, cfg.canScaleY));
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
  else cfg.animations.forEach((a, i) => {
    const w = `${name}.animations[${i}]`;
    if (typeof a.clip !== 'string') errs.push(`${w}.clip must be a string`);
    if (!['x', 'y', 'z'].includes(a.axis)) errs.push(`${w}.axis must be x|y|z`);
    if (!isNum(a.referenceTravel_m) || a.referenceTravel_m === 0) errs.push(`${w}.referenceTravel_m must be a non-zero number`);
    if (!isNum(a.travelPerDeltaHeight)) errs.push(`${w}.travelPerDeltaHeight must be a number`);
  });
  return errs;
}

/** Dispatch on cfg.schema. Nodes without cfg are reported by the caller. */
export function validateNodeCfg(name, cfg) {
  switch (cfg?.schema) {
    case ROOT_SCHEMA: return validateRootCfg(name, cfg);
    case GROUP_SCHEMA: return validateGroupCfg(name, cfg);
    default: return validatePartCfg(name, cfg);
  }
}
