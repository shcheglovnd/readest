/// <reference types="@vitest/browser-playwright" />
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { DocumentLoader } from '@/libs/document';
import type { FoliateView } from '@/types/view';
import type { InkStroke } from '@/services/handwriting/model';
import { HandwritingService } from '@/services/handwriting/handwritingService';
import { HandwritingEditor } from '@/services/handwriting/editor';
import HandwritingCanvas from '@/app/reader/components/handwriting/HandwritingCanvas';
import { MIN_ZOOM_LEVEL } from '@/services/constants';
import { measureInkFrames } from '@/services/handwriting/coords';
import '@/styles/globals.css';

const PDF = new URL('../fixtures/data/sample-alice.pdf', import.meta.url).href;
let view: FoliateView | undefined;
let service: HandwritingService | undefined;
let overlay: HTMLDivElement | undefined;

const openPDF = async () => {
  await import('foliate-js/view.js');
  const file = new File([await (await fetch(PDF)).arrayBuffer()], 'sample.pdf', {
    type: 'application/pdf',
  });
  const { book } = await new DocumentLoader(file).open();
  view = document.createElement('foliate-view') as FoliateView;
  Object.assign(view.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '360px',
    height: '600px',
  });
  document.body.append(view);
  await view.open(book);
  view.renderer.setAttribute('zoom', 'fit-width');
  view.renderer.setAttribute('flow', 'scrolled');
  view.renderer.setAttribute('scale-factor', 150);
  await view.goTo(0);
  await expect.poll(() => view!.renderer.getContents().length).toBeGreaterThan(0);
  const frame = view.renderer.getContents()[0]!.doc.defaultView!.frameElement as HTMLIFrameElement;
  await expect.poll(() => frame.clientHeight).toBeGreaterThan(600);
  return frame;
};

const saved: InkStroke = {
  id: 'saved',
  color: '#15803d',
  width: 0.01,
  points: [
    [0.3, 0.2],
    [0.5, 0.2],
  ],
};
const mountInk = async (
  frame: HTMLIFrameElement,
  interactive = false,
  frames: Element[] = [frame],
) => {
  const rect = measureInkFrames(frames)!;
  const cell = view!.getBoundingClientRect();
  overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '360px',
    height: '600px',
  });
  document.body.append(overlay);
  const editor = new HandwritingEditor({ 'pdf:0': { strokes: [saved], updatedAt: 1 } });
  service = new HandwritingService(editor, 'pdf:0', cell);
  service.onGesture((gesture) => {
    if (gesture.action !== 'pan') return false;
    if (view!.book.rendition?.layout !== 'pre-paginated') {
      view!.renderer.containerPosition -=
        view!.renderer.scrollProp === 'scrollLeft' ? gesture.dx : gesture.dy;
    } else view!.pan(-gesture.dx, -gesture.dy);
    return true;
  });
  render(
    <HandwritingCanvas
      layers={[{ strokes: [saved], rect, frames }]}
      cellRect={cell}
      interactive={interactive}
      overlayRef={() => {}}
      attach={(el) => {
        if (el) void service!.attach(el);
      }}
      detach={() => {
        void service!.detach();
      }}
    />,
    { container: overlay },
  );
  await expect.poll(() => frame.parentElement!.querySelector('canvas') !== null).toBe(true);
  return {
    editor,
    input: overlay.querySelector('canvas')!,
    ink: frame.parentElement!.querySelector('canvas')!,
  };
};

const toTop = (x: number, y: number) => {
  for (let w: Window = window; w !== w.parent; w = w.parent) {
    const rect = w.frameElement!.getBoundingClientRect();
    x += rect.left;
    y += rect.top;
  }
  return { x, y };
};
const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) => {
  await cdp().send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ ...toTop(x, y), id: 1 }],
  });
};

afterEach(async () => {
  await service?.detach();
  cleanup();
  overlay?.remove();
  view?.close();
  view?.remove();
  document.documentElement.dir = 'ltr';
  document.documentElement.removeAttribute('data-eink');
  document.documentElement.removeAttribute('data-theme');
});

describe('PDF ink, touch scrolling and small zoom in a real renderer', () => {
  it('keeps ink on the PDF synchronously during scrolling and live pinch transforms', async () => {
    const frame = await openPDF();
    const { ink } = await mountInk(frame);
    const relative = () => {
      const p = frame.getBoundingClientRect(),
        c = ink.getBoundingClientRect();
      return {
        left: c.left - p.left,
        top: c.top - p.top,
        width: c.width / p.width,
        height: c.height / p.height,
      };
    };
    const before = relative();
    // Do not yield to React or requestAnimationFrame: the compositor must move both.
    view!.renderer.scrollTop += 120;
    expect(relative()).toEqual(before);
    view!.renderer.pinchZoom?.(0.6);
    expect(relative()).toEqual(before);
    view!.renderer.pinchEnd?.();
    const pixels = ink.getContext('2d')!.getImageData(0, 0, ink.width, ink.height).data;
    expect(pixels.some((value, i) => i % 4 === 3 && value > 0)).toBe(true);
    expect(ink.width * ink.height).toBeLessThanOrEqual(2_000_000);
    view!.renderer.setAttribute('scale-factor', 500);
    await expect.poll(() => frame.getBoundingClientRect().width).toBeCloseTo(1800, 0);
    await expect.poll(() => ink.width * ink.height).toBeGreaterThan(1_900_000);
    expect(ink.width * ink.height).toBeLessThanOrEqual(2_000_000);
  }, 30000);

  it('follows a real finger drag before release after stylus input, without adding ink', async () => {
    const frame = await openPDF();
    const { input, editor } = await mountInk(frame, true);
    input.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'pen' }));
    const before = view!.renderer.scrollTop;
    await touch('touchStart', 180, 400);
    await touch('touchMove', 180, 350);
    await expect.poll(() => view!.renderer.scrollTop).toBeGreaterThan(before + 30);
    await touch('touchMove', 180, 320);
    const during = view!.renderer.scrollTop;
    expect(during).toBeGreaterThanOrEqual(before + 75);
    await touch('touchEnd', 180, 320);
    expect(view!.renderer.scrollTop).toBe(during);
    expect(editor.strokes('pdf:0')).toEqual([saved]);
  }, 30000);

  it.each([360, 1100])('keeps legacy paginated ink aligned at viewport width %i', async (width) => {
    await openPDF();
    view!.style.width = `${width}px`;
    view!.renderer.setAttribute('flow', 'paginated');
    view!.renderer.setAttribute('spread', width > 600 ? 'both' : 'auto');
    await view!.goTo(2);
    await expect
      .poll(
        () =>
          view!.renderer.getContents().filter((c) => {
            const r = c.doc.defaultView?.frameElement?.getBoundingClientRect();
            return r && r.width > 0 && r.height > 0;
          }).length,
      )
      .toBe(width > 600 ? 2 : 1);
    const frames = view!.renderer.getContents().map((c) => c.doc.defaultView!.frameElement!);
    const frame = frames.find((f) => f.getBoundingClientRect().width > 0) as HTMLIFrameElement;
    const { ink } = await mountInk(frame, false, frames);
    const relative = () => {
      const a = ink.getBoundingClientRect(),
        b = frame.getBoundingClientRect();
      return [a.left - b.left, a.top - b.top, a.width / b.width, a.height / b.height];
    };
    const before = relative();
    view!.renderer.scrollTop += 70;
    expect(relative()).toEqual(before);
    expect(
      ink
        .getContext('2d')!
        .getImageData(0, 0, ink.width, ink.height)
        .data.some((v, i) => i % 4 === 3 && v > 0),
    ).toBe(true);
  }, 30000);

  it('also pans a real scrolling EPUB without leaving finger ink', async () => {
    await import('foliate-js/view.js');
    const url = new URL('../fixtures/data/sample-alice.epub', import.meta.url).href;
    const file = new File([await (await fetch(url)).arrayBuffer()], 'alice.epub', {
      type: 'application/epub+zip',
    });
    const { book } = await new DocumentLoader(file).open();
    view = document.createElement('foliate-view') as FoliateView;
    Object.assign(view.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '360px',
      height: '600px',
    });
    document.body.append(view);
    await view.open(book);
    view.renderer.setAttribute('flow', 'scrolled');
    await view.goToFraction(0.2);
    await expect.poll(() => view!.renderer.getContents().length).toBeGreaterThan(0);
    const frame = view.renderer.getContents()[0]!.doc.defaultView!
      .frameElement as HTMLIFrameElement;
    const { input, editor } = await mountInk(frame, true);
    input.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'pen' }));
    const before = view.renderer.containerPosition;
    await touch('touchStart', 180, 400);
    await touch('touchMove', 180, 320);
    await expect.poll(() => view!.renderer.containerPosition).toBeGreaterThan(before + 60);
    await touch('touchEnd', 180, 320);
    expect(editor.strokes('pdf:0')).toEqual([saved]);
  }, 30000);

  it.each([
    20, 10,
  ])('renders a PDF page at %i percent and scales its saved ink with it', async (zoom) => {
    expect(MIN_ZOOM_LEVEL).toBeLessThanOrEqual(zoom);
    const frame = await openPDF();
    const { ink } = await mountInk(frame);
    view!.renderer.setAttribute('scale-factor', zoom);
    await expect.poll(() => frame.getBoundingClientRect().width).toBeCloseTo((360 * zoom) / 100, 0);
    expect(ink.getBoundingClientRect().width).toBeCloseTo(frame.getBoundingClientRect().width, 1);
    await expect
      .poll(() => frame.contentDocument!.querySelector('canvas')?.width ?? 0)
      .toBeGreaterThan(0);
    expect(frame.contentDocument!.querySelector('.textLayer')).not.toBeNull();
    for (const mode of ['light', 'dark', 'eink', 'rtl']) {
      document.documentElement.dataset['theme'] =
        mode === 'dark' ? 'default-dark' : 'default-light';
      document.documentElement.dataset['eink'] = String(mode === 'eink');
      document.documentElement.dir = mode === 'rtl' ? 'rtl' : 'ltr';
      const p = frame.getBoundingClientRect(),
        c = ink.getBoundingClientRect();
      expect(c.left).toBeCloseTo(p.left, 1);
      expect(c.top).toBeCloseTo(p.top, 1);
      expect(c.width).toBeCloseTo(p.width, 1);
      expect(c.height).toBeCloseTo(p.height, 1);
    }
  }, 30000);
});
