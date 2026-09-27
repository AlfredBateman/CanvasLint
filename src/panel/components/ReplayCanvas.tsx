/**
 * ReplayCanvas.tsx
 *
 * The secondary canvas element displayed in the DevTools panel.
 * Renders the reconstructed state for the timeline cursor position.
 *
 * ── Sizing strategy ───────────────────────────────────────────────────────────
 * We track the container's ResizeObserver and keep the canvas element sized
 * to fill it. The `width`/`height` attributes (bitmap dimensions) are set to
 * the container's clientWidth × clientHeight in CSS pixels. This means the
 * replay shows at panel resolution, not the captured page's canvas resolution.
 * A future improvement would let the user toggle between "fit" and "1:1" modes.
 *
 * ── Live mode overlay ─────────────────────────────────────────────────────────
 * When cursor is null (live mode) the canvas is empty and we show a ghost text
 * "Drag the slider to replay". When replaying, a spinner overlay appears.
 */

import { useRef, useEffect } from 'react';
import { useReplayEngine }  from '../useReplayEngine';
import { usePanelStore, selectTimelineCursor, selectIsReplaying } from '../usePanelStore';

interface ReplayCanvasProps {
  portRef: React.RefObject<chrome.runtime.Port | null>;
}

export function ReplayCanvas({ portRef }: ReplayCanvasProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const cursor      = usePanelStore(selectTimelineCursor);
  const isReplaying = usePanelStore(selectIsReplaying);

  // Wire the replay engine — it subscribes to cursor changes and drives the canvas
  useReplayEngine(canvasRef, portRef);

  // ResizeObserver: keep canvas bitmap size in sync with container
  useEffect(() => {
    const container = containerRef.current;
    const canvas    = canvasRef.current;
    if (!container || !canvas) return;

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      canvas.width  = Math.round(width  * devicePixelRatio);
      canvas.height = Math.round(height * devicePixelRatio);
      // Scale ctx so coordinate space matches CSS pixels
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.scale(devicePixelRatio, devicePixelRatio);
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const isLive = cursor === null;

  return (
    <div ref={containerRef} className="replay-canvas-container">
      <canvas
        ref={canvasRef}
        className="replay-canvas"
        aria-label="Canvas replay view"
        role="img"
      />

      {/* Live mode ghost overlay */}
      {isLive && (
        <div className="replay-canvas__overlay replay-canvas__overlay--live" aria-hidden="true">
          <span className="replay-canvas__ghost-icon">⏸</span>
          <span className="replay-canvas__ghost-text">
            Drag the timeline to replay
          </span>
        </div>
      )}

      {/* Replay-in-progress spinner */}
      {isReplaying && (
        <div className="replay-canvas__overlay replay-canvas__overlay--busy" aria-live="polite" aria-label="Replaying…">
          <span className="spinner" />
        </div>
      )}
    </div>
  );
}
