// Adaptive render quality to hold the target frame rate. Pure logic (no DOM / three.js), unit-testable.
//
// Feed it the time between consecutive *rendered* frames. If a window of frames averages over budget,
// it steps quality down one level. After a long run of on-budget frames it tries one level up. If that
// upgrade misses budget within PROBATION_WINDOWS, the level is locked so the governor does not oscillate.

const PROBATION_WINDOWS = 5;

export const QUALITY_LEVELS = [
  { name: 'High', pixelRatio: 2, ao: true, msaa: 4 },
  { name: 'Medium', pixelRatio: 1.5, ao: true, msaa: 4 },
  { name: 'Low', pixelRatio: 1.25, ao: false, msaa: 4 },
  { name: 'Lowest', pixelRatio: 1, ao: false, msaa: 2 },
];

export class FrameGovernor {
  constructor({ targetFps = 60, windowFrames = 40, upgradeAfterFrames = 900, levels = QUALITY_LEVELS } = {}) {
    this.levels = levels;
    this.budgetMs = 1000 / targetFps;
    this.windowFrames = windowFrames;
    this.upgradeAfterFrames = upgradeAfterFrames;
    this.level = 0;
    this.locked = new Set();     // levels proven too slow after an upgrade
    this.windowsSinceUpgrade = null; // counts windows after an upgrade, until probation ends
    this.#resetWindow();
    this.goodFrames = 0;
    this.lastFps = 0;
  }

  #resetWindow() { this.n = 0; this.sum = 0; }

  /** @returns {number|null} new level index when quality changes, else null */
  sample(deltaMs) {
    if (!(deltaMs > 0) || deltaMs > 250) return null; // stalls, hidden tab or first frame after idle
    this.n++;
    this.sum += deltaMs;
    if (this.n < this.windowFrames) return null;

    const avg = this.sum / this.n;
    this.lastFps = 1000 / avg;
    this.#resetWindow();

    if (avg > this.budgetMs * 1.1) {             // over budget (< ~54 fps at a 60 target)
      this.goodFrames = 0;
      if (this.windowsSinceUpgrade !== null) this.locked.add(this.level);
      this.windowsSinceUpgrade = null;
      if (this.level < this.levels.length - 1) return ++this.level;
      return null;
    }
    if (this.windowsSinceUpgrade !== null && ++this.windowsSinceUpgrade >= PROBATION_WINDOWS) this.windowsSinceUpgrade = null;
    if (avg <= this.budgetMs * 1.05) {
      this.goodFrames += this.windowFrames;
      const up = this.level - 1;
      if (this.goodFrames >= this.upgradeAfterFrames && up >= 0 && !this.locked.has(up)) {
        this.goodFrames = 0;
        this.level = up;
        this.windowsSinceUpgrade = 0;
        return up;
      }
    }
    return null;
  }
}
