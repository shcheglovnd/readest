export const DEFAULT_VOLUME_SCROLL_STEP = 25;

export const normalizeVolumeScrollStep = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(1, value))
    : DEFAULT_VOLUME_SCROLL_STEP;
