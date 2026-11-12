import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// Real deviceStore + eventDispatcher; only the native bridge boundary is mocked
// so we can observe the interceptKeys({ volumeKeys }) calls the store makes.
const h = vi.hoisted(() => ({
  appService: { isMobileApp: true } as { isMobileApp: boolean },
  viewSettings: { volumeKeysToFlip: true } as Record<string, unknown> | null,
  viewState: { inited: true } as Record<string, unknown> | null,
  hoveredBookKey: null as string | null,
  settingsState: {
    settings: { hardwarePageTurner: undefined },
    isSettingsDialogOpen: false,
  },
}));

vi.mock('@/utils/bridge', async (original) => ({
  ...(await original<object>()),
  interceptKeys: vi.fn(),
  getScreenBrightness: vi.fn(),
  setScreenBrightness: vi.fn(),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: h.appService }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: Object.assign(
    () => ({
      getViewSettings: () => h.viewSettings,
      getViewState: () => h.viewState,
      hoveredBookKey: h.hoveredBookKey,
      setHoveredBookKey: vi.fn(),
    }),
    { getState: () => ({ hoveredBookKey: h.hoveredBookKey }) },
  ),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData: () => ({}) }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: typeof h.settingsState) => unknown) =>
      selector ? selector(h.settingsState) : h.settingsState,
    { getState: () => h.settingsState },
  ),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: Object.assign(() => ({}), { getState: () => ({ sideBarBookKey: 'book-1' }) }),
}));

import { useDeviceControlStore } from '@/store/deviceStore';
import { usePagination } from '@/app/reader/hooks/usePagination';
import type { FoliateView } from '@/types/view';

import { DocumentLoader } from '@/libs/document';
import type { BookDoc } from '@/libs/document';

const epubURL = new URL('../../../fixtures/data/sample-alice.epub', import.meta.url).href;
const pdfURL = new URL('../../../fixtures/data/sample-alice.pdf', import.meta.url).href;
let view: FoliateView | undefined;
let book: BookDoc | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  useDeviceControlStore.setState({ volumeKeysInterceptionCount: 0, volumeKeysIntercepted: false });
  h.viewSettings = { volumeKeysToFlip: true, volumeKeysMode: 'scroll', volumeKeysScrollStep: 25 };
  h.viewState = { inited: true };
  h.hoveredBookKey = null;
  h.settingsState.isSettingsDialogOpen = false;
});

afterEach(() => {
  cleanup();
  view?.close();
  view?.remove();
  view = undefined;
  book = undefined;
});

const press = async (key: 'VolumeDown' | 'VolumeUp', repeat = false) => {
  await act(async () => {
    await window.onNativeKeyDown?.(key, key === 'VolumeDown' ? 25 : 24, repeat);
  });
};

const position = () => view!.renderer.start;

const load = async (format: 'epub' | 'pdf') => {
  const url = format === 'epub' ? epubURL : pdfURL;
  const response = await fetch(url);
  const file = new File([await response.arrayBuffer()], `sample.${format}`);
  book = (await new DocumentLoader(file).open()).book;
  await import('foliate-js/view.js');
  view = document.createElement('foliate-view') as FoliateView;
  Object.assign(view.style, {
    width: '360px',
    height: '600px',
    position: 'absolute',
    left: '0',
    top: '0',
  });
  document.body.appendChild(view);
  await view.open(book);
  view.renderer.setAttribute('animated', '');
  view.renderer.setAttribute('flow', 'scrolled');
  view.renderer.setAttribute('max-inline-size', '360');
  const target =
    format === 'epub' ? view.resolveCFI('epubcfi(/6/16!/4,,/2/2[chapter_466]/4/18/1:70)').index : 0;
  await view.renderer.goTo({ index: target });
  await vi.waitFor(
    () => {
      expect(view!.renderer.scrolled).toBe(true);
      expect(view!.renderer.size).toBeGreaterThan(100);
      expect(view!.renderer.getContents().length).toBeGreaterThan(0);
    },
    { timeout: 20000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  renderHook(() => usePagination('book-1', { current: view! }, { current: null }));
};

describe('volume steps with actual EPUB and PDF renderers', () => {
  test.each([
    'epub',
    'pdf',
  ] as const)('moves %s by the requested distance, backward and after a live step change', async (format) => {
    await load(format);
    const start = position();
    const viewport = view!.renderer.size;
    await press('VolumeDown');
    await vi.waitFor(() => expect(Math.abs(position() - start - viewport * 0.25)).toBeLessThan(3), {
      timeout: 10000,
    });
    const forward = position();
    h.viewSettings = { ...h.viewSettings, volumeKeysScrollStep: 5 };
    await press('VolumeDown');
    await vi.waitFor(
      () => expect(Math.abs(position() - forward - viewport * 0.05)).toBeLessThan(3),
      { timeout: 10000 },
    );
    const smallForward = position();
    await press('VolumeUp');
    await vi.waitFor(
      () => expect(Math.abs(position() - smallForward + viewport * 0.05)).toBeLessThan(3),
      { timeout: 10000 },
    );
  }, 40000);
  test.each([
    'epub',
    'pdf',
  ] as const)('keeps up with a held button in animated %s without trailing scrolls', async (format) => {
    await load(format);
    h.viewSettings = { ...h.viewSettings, volumeKeysScrollStep: 5 };
    await press('VolumeDown');
    await new Promise((resolve) => setTimeout(resolve, 550));
    const start = position();
    const step = view!.renderer.size * 0.05;
    const samples: number[] = [];
    let frame = 0;
    let relocations = 0;
    view!.addEventListener('relocate', () => {
      relocations++;
    });
    const sample = () => {
      samples.push(position());
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const heldAt = performance.now();
    try {
      for (let i = 0; i < 20; i++) {
        await press('VolumeDown', true);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await window.onNativeKeyUp?.('VolumeDown', 25);
    } finally {
      cancelAnimationFrame(frame);
    }
    expect(performance.now() - heldAt).toBeLessThan(2500);
    const advances = samples.slice(1).map((pos, index) => pos - samples[index]!);
    // More visible movements than native key repeats proves interpolation,
    // rather than twenty immediate jumps separated by unchanged frames.
    expect(advances.filter((delta) => delta > 0.5).length).toBeGreaterThan(25);
    expect(Math.abs(position() - start - step * 20)).toBeLessThan(step * 1.5);
    const released = position();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(Math.abs(position() - released)).toBeLessThan(3);
    expect(relocations).toBeGreaterThan(0);
    await press('VolumeUp', true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await window.onNativeKeyUp?.('VolumeUp', 24);
    expect(position()).toBeLessThan(released);
    expect(position()).toBeGreaterThanOrEqual(released - step * 1.5);
  }, 40000);
});
