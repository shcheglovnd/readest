export const DEFAULT_VOLUME_SCROLL_STEP = 25;

export const normalizeVolumeScrollStep = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(1, value))
    : DEFAULT_VOLUME_SCROLL_STEP;

// A finite per-repeat motion budget, consumed linearly on animation frames.
// New repeats extend the current motion rather than restart an animation.
// Capping the budget and cancelling on release prevents a scroll backlog.
export class VolumeScrollAnimator {
  private frame: number | null = null;
  private key: string | null = null;
  private lastRepeat = 0;
  private lastFrame = 0;
  private interval = 50;
  private distance = 0;
  private remaining = 0;
  private carry = 0;

  constructor(private readonly scrollBy: (delta: number) => boolean) {}

  repeat(key: string, distance: number) {
    const now = performance.now();
    if (key !== this.key) {
      this.stop();
      this.key = key;
      this.interval = 50;
    } else {
      const gap = now - this.lastRepeat;
      if (gap > 0 && gap <= 150) this.interval = Math.max(16, Math.min(100, gap));
    }
    this.lastRepeat = now;
    this.distance = distance;
    this.remaining = Math.min(Math.abs(distance) * 2, this.remaining + Math.abs(distance));
    if (this.frame === null) {
      this.lastFrame = now;
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  stop(key?: string) {
    if (key && key !== this.key) return;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.key = null;
    this.remaining = 0;
    this.carry = 0;
  }

  private tick = (time: number) => {
    this.frame = null;
    const elapsed = Math.max(0, time - this.lastFrame);
    this.lastFrame = time;
    // Never replay motion from a suspended or blocked WebView.
    if (elapsed > 100) {
      this.stop();
      return;
    }
    const amount = Math.min(this.remaining, (Math.abs(this.distance) * elapsed) / this.interval);
    this.remaining -= amount;
    this.carry += Math.sign(this.distance) * amount;
    const whole = Math.sign(this.carry) * Math.floor(Math.abs(this.carry) + 1e-7);
    this.carry -= whole;
    if (whole && !this.scrollBy(whole)) {
      this.stop();
      return;
    }
    if (this.remaining > 1e-7) this.frame = requestAnimationFrame(this.tick);
  };
}
