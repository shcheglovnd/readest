import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useHandwriting } from '@/app/reader/hooks/useHandwriting';
import type { BookNote } from '@/types/book';

const h = vi.hoisted(() => {
  const readerState = {
    viewStates: { 'book-1': { drawingEnabled: true } },
    setDrawingEnabled: () => {},
    getView: (): unknown => null,
    getViewSettings: () => ({ scrolled: false }),
  };
  const settingsState = {
    settings: {
      globalReadSettings: {
        handwritingTool: 'pen',
        handwritingColor: '#1a1a1a',
        handwritingWidth: 0.004,
        handwritingMarkerColor: '#ffeb3b',
        handwritingMarkerWidth: 0.02,
      },
    },
  };
  return {
    readerState,
    settingsState,
    bookData: { isFixedLayout: true },
    booknotes: [] as BookNote[],
  };
});

vi.mock('@/store/readerStore', () => ({
  useReaderStore: Object.assign(
    (selector?: (state: typeof h.readerState) => unknown) =>
      selector ? selector(h.readerState) : h.readerState,
    { getState: () => h.readerState },
  ),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(() => h.settingsState, { getState: () => h.settingsState }),
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => h.bookData,
    getConfig: () => ({ booknotes: h.booknotes }),
    setConfig: vi.fn(),
    saveConfig: vi.fn(),
  }),
}));

vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({ location: 'page-2', section: { current: 1 } }),
}));

vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);

const rect = (left: number) =>
  ({ left, top: 150, width: 412, height: 616, right: left + 412, bottom: 766 }) as DOMRect;

/** A fixed-layout view showing one page frame, as foliate-view lays it out. */
const mountView = () => {
  const view = document.createElement('foliate-view') as HTMLElement & {
    renderer: HTMLElement & { getContents: () => unknown[]; containerPosition: number };
  };
  const renderer = document.createElement('div') as unknown as typeof view.renderer;
  const root = renderer.attachShadow({ mode: 'open' });
  const page = document.createElement('div');
  const frame = document.createElement('iframe');
  page.appendChild(frame);
  root.appendChild(page);
  view.appendChild(renderer);
  Object.assign(view, { pan: vi.fn(), isOverflowX: () => false, isOverflowY: () => false });
  view.renderer = renderer;
  document.body.appendChild(view);
  renderer.getContents = () => [{ doc: { defaultView: { frameElement: frame } }, index: 1 }];
  return { view, frame };
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  h.booknotes = [];
  h.bookData.isFixedLayout = true;
  h.readerState.getViewSettings = () => ({ scrolled: false });
});

describe('useHandwriting after a page turn', () => {
  it('re-measures the page once a push turn slides the view into place', async () => {
    const { view, frame } = mountView();
    h.readerState.getView = () => view;
    // Mid-turn: the push animation has the view one page width to the side.
    let frameLeft = 412;
    vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(() => rect(frameLeft));

    const { result } = renderHook(() => useHandwriting('book-1'));
    act(() => result.current.containerRef(document.createElement('div')));
    await waitFor(() => expect(result.current.pageRect.left).toBe(412));
    // Let the measuring frames scheduled on mount run before the turn lands.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    // The turn settles: its last frame writes the resting transform on the view.
    frameLeft = 0;
    act(() => {
      view.style.transform = 'translate3d(0px, 0, 0)';
    });

    await waitFor(() => expect(result.current.pageRect.left).toBe(0));
  });
});

describe('useHandwriting finger navigation', () => {
  it.each([
    false,
    true,
  ])('routes a finger swipe through drawing mode (scrolled=%s)', async (scrolled) => {
    const { view } = mountView();
    const goRight = vi.fn();
    const next = vi.fn();
    const pan = vi.fn();
    Object.assign(view, { goRight, next, pan });
    h.readerState.getView = () => view;
    h.readerState.getViewSettings = () => ({ scrolled });
    const { result } = renderHook(() => useHandwriting('book-1'));
    const canvas = document.createElement('div');
    canvas.setPointerCapture = vi.fn();
    await act(() => result.current.attach(canvas));
    const pointer = (type: string, pointerType: string, x: number, y: number) => {
      const event = new Event(type);
      Object.assign(event, { pointerId: 1, pointerType, clientX: x, clientY: y });
      canvas.dispatchEvent(event);
    };
    act(() => {
      pointer('pointerover', 'pen', 0, 0);
      pointer('pointerdown', 'touch', 200, 200);
      pointer('pointerup', 'touch', scrolled ? 200 : 100, scrolled ? 100 : 200);
    });
    expect(scrolled ? pan : goRight).toHaveBeenCalledOnce();
    if (scrolled) {
      expect(pan).toHaveBeenCalledWith(-0, 100);
      expect(next).not.toHaveBeenCalled();
    }
    expect(result.current.layers.flatMap((layer) => layer.strokes)).toEqual([]);
    await act(() => result.current.detach());
    h.readerState.getViewSettings = () => ({ scrolled: false });
  });
});

describe('useHandwriting horizontal scrolling', () => {
  it('pans horizontally instead of turning a page when swiping right', async () => {
    const { view } = mountView();
    const goLeft = vi.fn();
    const next = vi.fn();
    const pan = vi.fn();
    Object.assign(view, { goLeft, next, pan });
    Object.assign(view.renderer, { scrollProp: 'scrollLeft' });
    h.readerState.getView = () => view;
    h.readerState.getViewSettings = () => ({ scrolled: true });
    const { result } = renderHook(() => useHandwriting('book-1'));
    const canvas = document.createElement('div');
    canvas.setPointerCapture = vi.fn();
    await act(() => result.current.attach(canvas));
    const pointer = (type: string, pointerType: string, clientX: number) => {
      const event = new Event(type);
      Object.assign(event, { pointerId: 1, pointerType, clientX, clientY: 200 });
      canvas.dispatchEvent(event);
    };
    act(() => {
      pointer('pointerover', 'pen', 0);
      pointer('pointerdown', 'touch', 100);
      pointer('pointerup', 'touch', 200);
    });
    expect(pan).toHaveBeenCalledWith(-100, -0);
    expect(goLeft).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    await act(() => result.current.detach());
    h.readerState.getViewSettings = () => ({ scrolled: false });
  });
});

describe('drawing mode continuous scrolling', () => {
  it('pans on each move, preserves direction, and does not turn a screen on release', async () => {
    const { view } = mountView();
    const pan = vi.fn();
    const next = vi.fn();
    Object.assign(view, { pan, next });
    h.readerState.getView = () => view;
    h.readerState.getViewSettings = () => ({ scrolled: true });
    const { result } = renderHook(() => useHandwriting('book-1'));
    const canvas = document.createElement('div');
    canvas.setPointerCapture = vi.fn();
    await act(() => result.current.attach(canvas));
    const pointer = (type: string, pointerType: string, x: number, y: number) => {
      const event = new Event(type);
      Object.assign(event, { pointerId: 1, pointerType, clientX: x, clientY: y });
      canvas.dispatchEvent(event);
    };
    act(() => {
      pointer('pointerover', 'pen', 0, 0);
      pointer('pointerdown', 'touch', 200, 200);
      pointer('pointermove', 'touch', 190, 160);
    });
    expect(pan).toHaveBeenLastCalledWith(10, 40);
    act(() => pointer('pointermove', 'touch', 193, 158));
    expect(pan).toHaveBeenLastCalledWith(-3, 2);
    act(() => pointer('pointerup', 'touch', 193, 158));
    expect(next).not.toHaveBeenCalled();
    await act(() => result.current.detach());
    h.readerState.getViewSettings = () => ({ scrolled: false });
  });

  it('ignores zero-sized hidden spread frames when measuring ink coordinates', async () => {
    const { view, frame } = mountView();
    h.readerState.getView = () => view;
    h.readerState.getViewSettings = () => ({ scrolled: false });
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(50));
    const hidden = document.createElement('iframe');
    view.renderer.shadowRoot!.append(hidden);
    const original = view.renderer.getContents;
    view.renderer.getContents = () => [
      ...original(),
      { doc: { defaultView: { frameElement: hidden } }, index: 2 },
    ];
    const { result } = renderHook(() => useHandwriting('book-1'));
    act(() => result.current.containerRef(document.createElement('div')));
    await waitFor(() =>
      expect(result.current.pageRect).toEqual({ left: 50, top: 150, width: 412, height: 616 }),
    );
  });
});

describe('drawing pan constraints', () => {
  it.each([
    true,
    false,
  ])('honors horizontal lock, with horizontal reading flow exempt (%s)', async (horizontal) => {
    const { view } = mountView();
    const pan = vi.fn();
    Object.assign(view, { pan });
    Object.assign(view.renderer, { scrollProp: horizontal ? 'scrollLeft' : 'scrollTop' });
    h.readerState.getView = () => view;
    h.readerState.getViewSettings = () => ({ scrolled: true, lockHorizontalPan: true });
    const { result } = renderHook(() => useHandwriting('book-1'));
    const canvas = document.createElement('div');
    canvas.setPointerCapture = vi.fn();
    await act(() => result.current.attach(canvas));
    const pointer = (type: string, pointerType: string, x: number, y: number) => {
      const event = new Event(type);
      Object.assign(event, { pointerId: 1, pointerType, clientX: x, clientY: y });
      canvas.dispatchEvent(event);
    };
    act(() => {
      pointer('pointerover', 'pen', 0, 0);
      pointer('pointerdown', 'touch', 100, 200);
      pointer('pointermove', 'touch', 60, 170);
      pointer('pointerup', 'touch', 60, 170);
    });
    expect(pan).toHaveBeenLastCalledWith(horizontal ? 40 : 0, 30);
    await act(() => result.current.detach());
    h.readerState.getViewSettings = () => ({ scrolled: false });
  });
});

describe('continuous EPUB drawing navigation', () => {
  it('uses the scrolling position instead of the paginated pan API', async () => {
    const { view } = mountView();
    const pan = vi.fn();
    Object.assign(view, { pan });
    Object.assign(view.renderer, { scrollProp: 'scrollTop', containerPosition: 200 });
    h.bookData.isFixedLayout = false;
    h.readerState.getView = () => view;
    h.readerState.getViewSettings = () => ({ scrolled: true });
    const { result } = renderHook(() => useHandwriting('book-1'));
    const canvas = document.createElement('div');
    canvas.setPointerCapture = vi.fn();
    await act(() => result.current.attach(canvas));
    const pointer = (type: string, pointerType: string, y: number) => {
      const event = new Event(type);
      Object.assign(event, { pointerId: 1, pointerType, clientX: 100, clientY: y });
      canvas.dispatchEvent(event);
    };
    act(() => {
      pointer('pointerover', 'pen', 0);
      pointer('pointerdown', 'touch', 200);
      pointer('pointermove', 'touch', 160);
    });
    expect(view.renderer.containerPosition).toBe(240);
    expect(pan).not.toHaveBeenCalled();
    await act(() => result.current.detach());
    h.bookData.isFixedLayout = true;
    h.readerState.getViewSettings = () => ({ scrolled: false });
  });
});

describe('cold PDF ink loading', () => {
  it('rebuilds page keys when saved notes load before the PDF layout is known', async () => {
    const { view, frame } = mountView();
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(0));
    h.readerState.getView = () => view;
    h.readerState.getViewSettings = () => ({ scrolled: true });
    h.bookData.isFixedLayout = false;
    h.booknotes = [
      {
        id: 'ink-saved',
        type: 'ink',
        cfi: 'epubcfi(/6/4!)',
        text: '',
        note: '',
        createdAt: 1,
        updatedAt: 1,
        ink: [
          {
            id: 'saved-stroke',
            color: '#000000',
            width: 0.005,
            page: 1,
            points: [
              [0.2, 0.3],
              [0.4, 0.5],
            ],
          },
        ],
      },
    ];
    const { result, rerender } = renderHook(() => useHandwriting('book-1'));
    const cell = document.createElement('div');
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect(0));
    act(() => result.current.containerRef(cell));
    // PDF parsing completes after the config/notes read, without changing notes.
    h.bookData.isFixedLayout = true;
    rerender();
    await waitFor(() =>
      expect(result.current.layers.flatMap((l) => l.strokes).map((s) => s.id)).toContain(
        'saved-stroke',
      ),
    );
    expect(h.booknotes[0]!.ink![0]!.page).toBe(1);
  });
});
