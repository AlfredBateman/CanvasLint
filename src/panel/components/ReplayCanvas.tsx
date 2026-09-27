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
 * When cursor is null (live mode) the canvas is empty and we say how many
 * commands can be replayed. While replaying, an "executing" tag shows.
 */

import { useRef, useEffect } from 'react';
import { useReplayEngine }  from '../useReplayEngine';
import {
  usePanelStore,
  selectTimelineCursor,
  selectIsReplaying,
  selectCommandCount,
} from '../usePanelStore';

interface ReplayCanvasProps {
  portRef: React.RefObject<chrome.runtime.Port | null>;
}

export function ReplayCanvas({ portRef }: ReplayCanvasProps) {
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const cursor      = usePanelStore(selectTimelineCursor);
  const isReplaying = usePanelStore(selectIsReplaying);
  const commandCount = usePanelStore(selectCommandCount);

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

      {/* Live mode: nothing replayed yet — the canvas is intentionally blank */}
      {isLive && (
        <div className="replay-canvas__overlay" aria-hidden="true">
          {commandCount === 0 ? (
            <>
              <strong>No commands captured</strong>
              <span>Record, then draw on the inspected page.</span>
              <span>The count refreshes only when the panel reconnects.</span>
            </>
          ) : (
            <>
              <strong>{commandCount} commands captured</strong>
              <span>Scrub the timeline to re-execute them from command 0.</span>
            </>
          )}
        </div>
      )}

      {/* Replay in progress */}
      {isReplaying && (
        <span className="replay-canvas__busy" aria-live="polite">[ executing ]</span>
      )}
    </div>
  );
}
