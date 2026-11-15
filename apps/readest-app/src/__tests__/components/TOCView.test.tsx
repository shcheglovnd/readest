import { render, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { BookDoc, TOCItem } from '@/libs/document';
import type { TOCDisplayItem } from '@/app/reader/components/sidebar/TOCItem';

const bookDoc = { sections: [], rendition: {} } as unknown as BookDoc;

// ---------- Shared mutable test state (captured by the mock factories) ----------
let scrollToIndexSpy: Mock<(arg: unknown) => void>;
// Only the FIRST (mount-time) `initialized` callback is captured, mirroring how
// OverlayScrollbars binds its event handlers when it initializes the viewport.
// A fix that relied on a fresher render closure would pass against the latest
// callback but still break in the real app — so the test forces a ref-based fix.
let capturedInitialized:
  | ((instance: { elements: () => { viewport: HTMLElement } }) => void)
  | undefined;
let mockProgress: { sectionHref: string; location: string } | null;
let listProps: {
  data?: TOCDisplayItem[];
  itemContent: (index: number, row: TOCDisplayItem | undefined) => React.ReactNode;
};

// ---------- Mocks ----------
vi.mock('@/store/readerStore', () => {
  const state = {
    getView: () => undefined,
    getViewSettings: () => ({ isEink: false }),
    getProgress: () => mockProgress,
  };
  return {
    useReaderStore: <R,>(selector?: (s: typeof state) => R) => (selector ? selector(state) : state),
  };
});

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ sideBarBookKey: 'book1', isSideBarVisible: true }),
}));

vi.mock('@/services/nav', () => ({ findParentPath: () => [] }));

vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock('@/utils/misc', () => ({ getContentMd5: (s: string) => s }));

vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));

vi.mock('@/app/reader/hooks/useTextTranslation', () => ({
  useTextTranslation: () => {},
}));

// Virtuoso is replaced with a stub that exposes a spy-able `scrollToIndex`
// through the imperative handle and hands TOCView a scroller element.
vi.mock('react-virtuoso', async () => {
  const ReactMod = await import('react');
  return {
    Virtuoso: ReactMod.forwardRef(
      (
        props: typeof listProps & { scrollerRef?: (el: HTMLElement | Window | null) => void },
        ref: React.Ref<unknown>,
      ) => {
        listProps = props;
        ReactMod.useImperativeHandle(ref, () => ({
          scrollToIndex: (arg: unknown) => scrollToIndexSpy(arg),
        }));
        ReactMod.useEffect(() => {
          props.scrollerRef?.(document.createElement('div'));
        }, []);
        return null;
      },
    ),
  };
});

describe('TOCView — changing virtualized rows', () => {
  it('renders the row from Virtuoso’s snapshot while the TOC shrinks', () => {
    const toc = makeFlatToc(30);
    const { rerender } = render(<TOCView bookKey='book1' bookDoc={bookDoc} toc={toc} />);
    // A measured list can retain its old rows for one render while accepting
    // a new itemContent callback. This index is outside the new, shorter TOC.
    const previousRow: TOCDisplayItem = { item: toc[29]!, depth: 0, index: 29 };
    rerender(<TOCView bookKey='book1' bookDoc={bookDoc} toc={toc.slice(0, 5)} />);

    expect(() => render(listProps.itemContent(29, previousRow))).not.toThrow();
    expect(document.querySelector('[title="Chapter 29"]')).not.toBeNull();
    expect(listProps.data).toHaveLength(5);
  });

  it('does not substitute a different row when a current-position row shifts indices', () => {
    const toc = makeFlatToc(5);
    render(<TOCView bookKey='book1' bookDoc={bookDoc} toc={toc} />);
    const position: TOCDisplayItem = { isCurrentPosition: true, depth: 1, page: 310 };

    const { getByRole } = render(listProps.itemContent(1, position));
    expect(getByRole('treeitem', { name: 'Current position, 310' })).toBeTruthy();
  });

  it('skips a transient row with no data instead of crashing the reader', () => {
    render(<TOCView bookKey='book1' bookDoc={bookDoc} toc={makeFlatToc(5)} />);

    expect(() => listProps.itemContent(100, undefined)).not.toThrow();
    expect(listProps.itemContent(100, undefined)).toBeNull();
  });
});

// Capture the OverlayScrollbars `initialized` callback so the test can fire it
// on demand (the real hook fires it after a deferred, timing-dependent init).
vi.mock('overlayscrollbars-react', () => ({
  useOverlayScrollbars: (opts: {
    events?: { initialized?: (i: { elements: () => { viewport: HTMLElement } }) => void };
  }) => {
    if (!capturedInitialized) capturedInitialized = opts.events?.initialized;
    return [vi.fn(), () => undefined];
  },
}));

// eslint-disable-next-line import/first
import TOCView from '@/app/reader/components/sidebar/TOCView';

const makeFlatToc = (count: number): TOCItem[] =>
  Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    label: `Chapter ${i}`,
    href: `ch${i}.html`,
    index: i,
  }));

const fireOverlayScrollbarsInitialized = () => {
  act(() => {
    capturedInitialized?.({ elements: () => ({ viewport: document.createElement('div') }) });
  });
};

beforeEach(() => {
  scrollToIndexSpy = vi.fn<(arg: unknown) => void>();
  capturedInitialized = undefined;
  mockProgress = null;
  // Run rAF synchronously so the callback's scroll happens inside act().
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TOCView — OverlayScrollbars init does not rewind the TOC to the top', () => {
  it('re-applies the auto-scroll to the active item when OverlayScrollbars initializes after the reading position arrives', () => {
    const toc = makeFlatToc(8);
    const activeHref = 'ch5.html';

    // Fresh refresh: TOCView mounts before the first relocate, so `progress`
    // (and thus the mount-time initialScrollTarget) has no reading position.
    mockProgress = null;
    const { rerender } = render(<TOCView bookKey='book1' bookDoc={bookDoc} toc={toc} />);

    // The relocate arrives → the normal auto-scroll effect centers the active
    // chapter. (OverlayScrollbars' deferred init, which resets scrollTop to 0,
    // has not fired yet.)
    mockProgress = { sectionHref: activeHref, location: 'epubcfi(/6/12!/4/1:0)' };
    act(() => {
      rerender(<TOCView bookKey='book1' bookDoc={bookDoc} toc={toc} />);
    });

    // Ignore that first scroll; we only care whether the OverlayScrollbars init
    // (which clobbers scrollTop) re-applies it instead of stranding the top.
    scrollToIndexSpy.mockClear();

    fireOverlayScrollbarsInitialized();

    expect(scrollToIndexSpy).toHaveBeenCalledWith(expect.objectContaining({ index: 5 }));
  });

  it('does not force a scroll on OverlayScrollbars init when there is no reading position', () => {
    const toc = makeFlatToc(8);

    mockProgress = null;
    render(<TOCView bookKey='book1' bookDoc={bookDoc} toc={toc} />);

    scrollToIndexSpy.mockClear();
    fireOverlayScrollbarsInitialized();

    expect(scrollToIndexSpy).not.toHaveBeenCalled();
  });
});
