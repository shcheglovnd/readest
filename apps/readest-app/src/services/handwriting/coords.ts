export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Screen (CSS px) → normalized page coordinates. The rect is the page's
 * current on-screen bounds, so scroll, zoom, resize and rotation are all
 * absorbed by whoever measures the rect; persisted ink never sees them.
 */
export const screenToPage = (p: Point2D, rect: PageRect, opts?: { clamp?: boolean }): Point2D => {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  let x = (p.x - rect.left) / rect.width;
  let y = (p.y - rect.top) / rect.height;
  if (opts?.clamp) {
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
  }
  return { x, y };
};

/** Visible page bounds only: a hidden spread frame has a zero rect at (0, 0). */
export const measureInkFrames = (frames: readonly Element[]): PageRect | null => {
  const rects = frames
    .map((frame) => frame.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  return {
    left,
    top,
    width: Math.max(...rects.map((r) => r.right)) - left,
    height: Math.max(...rects.map((r) => r.bottom)) - top,
  };
};
