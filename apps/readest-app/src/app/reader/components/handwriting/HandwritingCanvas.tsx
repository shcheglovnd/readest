import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { renderStrokes } from '@/services/handwriting/renderer';
import { measureInkFrames, type PageRect } from '@/services/handwriting/coords';
import type { InkLayer } from '../../hooks/useHandwriting';

interface HandwritingCanvasProps {
  /** Ink to draw, each layer normalized to its own rect in viewport coordinates. */
  layers: InkLayer[];
  /** The overlay's own bounds; the canvas covers it. */
  cellRect: PageRect;
  interactive: boolean;
  overlayRef: (el: HTMLDivElement | null) => void;
  attach: (el: HTMLElement | null) => void;
  detach: () => void;
}

/**
 * Paint inside the renderer's page container. Native/compositor scrolling and
 * pinch transforms now move the PDF and its ink together, without a React frame
 * measuring and chasing the page from a viewport-sized overlay.
 */
const PageInkCanvas = ({ layer, frame }: { layer: InkLayer; frame: Element }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const framesRef = useRef(layer.frames);
  framesRef.current = layer.frames;
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const draw = () => {
      const bounds = measureInkFrames(framesRef.current ?? [frame]);
      const target = frame.getBoundingClientRect();
      if (!bounds || !target.width || !target.height) return;
      const width = frame.clientWidth;
      const height = frame.clientHeight;
      if (!width || !height) return;
      // Only annotated pages allocate a raster, capped at 2 Mpx even at 500%.
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(2_000_000 / (width * height)),
        4096 / Math.max(width, height),
      );
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      ctx.clearRect(0, 0, width, height);
      // A paginated spread has legacy ink normalized to both pages together.
      // Render that same coordinate space clipped to each page; no data rewrite.
      renderStrokes(
        ctx,
        layer.strokes,
        {
          left: ((bounds.left - target.left) * width) / target.width,
          top: ((bounds.top - target.top) * height) / target.height,
          width: (bounds.width * width) / target.width,
          height: (bounds.height * height) / target.height,
        },
        false,
      );
    };
    draw();
    const observer = new ResizeObserver(draw);
    for (const f of framesRef.current ?? [frame]) observer.observe(f);
    return () => observer.disconnect();
  }, [frame, layer.strokes]);
  if (!frame.parentElement) return null;
  return createPortal(
    <canvas
      ref={canvasRef}
      data-page-ink=''
      aria-hidden='true'
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />,
    frame.parentElement,
  );
};

/**
 * Renders committed + in-progress ink on a canvas positioned over the
 * reader viewport. Purely a rendering + input-capture surface: all state
 * lives in useHandwriting/HandwritingService, so this re-renders on prop
 * changes only, never on its own timers.
 */
const HandwritingCanvas: React.FC<HandwritingCanvasProps> = ({
  layers,
  cellRect,
  interactive,
  overlayRef,
  attach,
  detach,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = Math.max(1, Math.round(cellRect.width * dpr));
    canvas.height = Math.max(1, Math.round(cellRect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cellRect.width, cellRect.height);
    for (const { strokes, rect, frames } of layers) {
      if (frames) continue;
      renderStrokes(
        ctx,
        strokes,
        {
          left: rect.left - cellRect.left,
          top: rect.top - cellRect.top,
          width: rect.width,
          height: rect.height,
        },
        false,
      );
    }
  }, [layers, cellRect, dpr]);

  useEffect(() => {
    if (!interactive) return;
    const el = canvasRef.current;
    void attach(el);
    return () => {
      void detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  return (
    <>
      {layers.flatMap((layer, i) =>
        layer.strokes.length
          ? (layer.frames ?? []).map((frame, j) => (
              <PageInkCanvas key={`${i}-${j}`} layer={layer} frame={frame} />
            ))
          : [],
      )}
      <div
        ref={overlayRef}
        className='pointer-events-none absolute inset-0'
        style={{ touchAction: interactive ? 'none' : undefined }}
      >
        <canvas
          ref={canvasRef}
          className={interactive ? 'pointer-events-auto absolute inset-0' : 'absolute inset-0'}
          style={{
            width: cellRect.width,
            height: cellRect.height,
            touchAction: 'none',
            // Nothing to select here; keeps iOS selection gestures off the Pencil.
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
          }}
        />
      </div>
    </>
  );
};

export default HandwritingCanvas;
