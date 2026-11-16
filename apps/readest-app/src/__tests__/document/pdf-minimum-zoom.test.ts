import { describe, expect, it } from 'vitest';
import { MIN_ZOOM_LEVEL, ZOOM_STEP } from '@/services/constants';
describe('PDF zoom out range', () => {
  it('allows the existing decrement to reach 20% and 10%', () => {
    let zoom = 50;
    for (let i = 0; i < 3; i++) zoom = Math.max(MIN_ZOOM_LEVEL, zoom - ZOOM_STEP);
    expect(zoom).toBe(20);
    zoom = Math.max(MIN_ZOOM_LEVEL, zoom - ZOOM_STEP);
    expect(zoom).toBe(10);
    expect(Math.max(MIN_ZOOM_LEVEL, zoom - ZOOM_STEP)).toBe(10);
  });
});
