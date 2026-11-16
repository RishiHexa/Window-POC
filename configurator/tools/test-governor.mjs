#!/usr/bin/env node
// Unit checks for FrameGovernor (adaptive quality for the 60 fps target).
import { FrameGovernor, QUALITY_LEVELS } from '../src/configurator/FrameGovernor.js';
let fail = 0; const check = (ok, m) => { if (!ok) { fail++; console.log('  FAIL', m); } };
const feed = (g, ms, n) => { const changes = []; for (let i = 0; i < n; i++) { const c = g.sample(ms); if (c !== null) changes.push(c); } return changes; };

let g = new FrameGovernor();
check(feed(g, 16.7, 2000).length === 0 && g.level === 0, 'steady 60 fps keeps High');
g = new FrameGovernor();
check(JSON.stringify(feed(g, 25, 40 * 10)) === '[1,2,3]' && g.level === 3, 'sustained 40 fps degrades to Lowest and stops');
g = new FrameGovernor();
feed(g, 25, 40); check(g.level === 1, 'one slow window drops one level');
feed(g, 16.7, 960); check(g.level === 0, 'long on-budget run upgrades back');
feed(g, 25, 40); check(g.level === 1 && g.locked.has(0), 'failing right after upgrade locks that level');
feed(g, 16.7, 5000); check(g.level === 1, 'locked level is not retried (no oscillation)');
g = new FrameGovernor();
check(feed(g, 500, 200).length === 0 && g.level === 0, 'stalls / hidden-tab gaps are ignored');
g = new FrameGovernor();
check(feed(g, 8.3, 2000).length === 0 && g.level === 0, '120 Hz displays stay at High');
check(QUALITY_LEVELS.length === 4, 'four quality levels');
console.log(fail ? `FAILED: ${fail}` : 'OK: governor checks passed');
process.exit(fail ? 1 : 0);
