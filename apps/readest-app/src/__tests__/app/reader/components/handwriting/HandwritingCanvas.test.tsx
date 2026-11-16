import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import HandwritingCanvas from '@/app/reader/components/handwriting/HandwritingCanvas';
import { renderStrokes } from '@/services/handwriting/renderer';

vi.mock('@/services/handwriting/renderer', () => ({ renderStrokes: vi.fn() }));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);
const rect = { left: 20, top: -100, width: 400, height: 600 };
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('keeps fixed-page ink inside the page, with no duplicate viewport raster', () => {
  const parent = document.createElement('div');
  const frame = document.createElement('iframe');
  parent.append(frame);
  document.body.append(parent);
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    right: 420,
    bottom: 500,
  } as DOMRect);
  Object.defineProperties(frame, { clientWidth: { value: 400 }, clientHeight: { value: 600 } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const stroke = {
    id: 'saved',
    color: '#000000',
    width: 0.005,
    points: [
      [0.2, 0.3],
      [0.4, 0.5],
    ] as [number, number][],
  };
  const { unmount } = render(
    <HandwritingCanvas
      layers={[{ strokes: [stroke], rect, frames: [frame] }]}
      cellRect={{ left: 0, top: 0, width: 400, height: 800 }}
      interactive={false}
      overlayRef={vi.fn()}
      attach={vi.fn()}
      detach={vi.fn()}
    />,
  );
  expect(parent.querySelector('canvas')).not.toBeNull();
  expect(renderStrokes).toHaveBeenCalledWith(
    expect.anything(),
    [stroke],
    { left: 0, top: 0, width: 400, height: 600 },
    false,
  );
  expect(vi.mocked(renderStrokes).mock.calls.filter(([, strokes]) => strokes.length)).toHaveLength(
    1,
  );
  unmount();
  expect(parent.querySelector('canvas')).toBeNull();
});
