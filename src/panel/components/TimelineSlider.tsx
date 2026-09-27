/**
 * TimelineSlider.tsx
 *
 * The main timeline scrubber for deterministic replay.
 *
 * ── Deterministic replay semantics ────────────────────────────────────────────
 * • value === null      → Live mode. Slider is at max. No replay executes.
 * • value === 0…N       → Step mode. Replay engine re-executes commands 0..N.
 *
 * The slider renders block boundary markers (ticks) derived from the
 * renderBlocks array to give the user visual cues about where logical groups
 * start/end on the command timeline.
 *
 * ── Keyboard support ──────────────────────────────────────────────────────────
 * Arrow keys nudge by 1 command. Shift+Arrow nudges by 10.
 * Home/End jump to first/last command.
 *
 * ── Performance ───────────────────────────────────────────────────────────────
 * onChange fires on every pixel of drag which would trigger too many replays.
 * We debounce at 50 ms — fast enough for responsive scrubbing but infrequent
 * enough to not saturate the replay engine.
 */

import { useCallback, useRef, useMemo } from 'react';
import {
  usePanelStore,
  selectCommandCount,
  selectTimelineCursor,
  selectIsReplaying,
  selectRenderBlocks,
  selectActions,
} from '../usePanelStore';
import type { RenderBlock } from '../../types/render-blocks';

const DEBOUNCE_MS = 50;

function kindColor(kind: RenderBlock['kind']): string {
  if (kind === 'path')      return '#7c3aed';
  if (kind === 'immediate') return '#0891b2';
  return '#374151';
}

export function TimelineSlider() {
  const commandCount   = usePanelStore(selectCommandCount);
  const cursor         = usePanelStore(selectTimelineCursor);
  const isReplaying    = usePanelStore(selectIsReplaying);
  const renderBlocks   = usePanelStore(selectRenderBlocks);
  const { setTimelineCursor } = usePanelStore(selectActions);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null!);

  const max = Math.max(0, commandCount - 1);
  // slider integer value: null cursor → max (live mode)
  const sliderValue = cursor ?? max;
  const isLive      = cursor === null;

  // ── Block tick positions ─────────────────────────────────────────────────
  const ticks = useMemo(() => {
    if (max === 0) return [];
    return renderBlocks.map((b) => ({
      id:    b.id,
      left:  ((b.endIndex / max) * 100).toFixed(4) + '%',
      color: kindColor(b.kind),
    }));
  }, [renderBlocks, max]);

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // If dragged to max → switch back to live mode
      setTimelineCursor(val >= max ? null : val);
    }, DEBOUNCE_MS);
  }, [max, setTimelineCursor]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const step = e.shiftKey ? 10 : 1;
    const cur  = cursor ?? max;

    if (e.key === 'ArrowLeft'  || e.key === 'ArrowDown') {
      e.preventDefault();
      setTimelineCursor(Math.max(0, cur - step));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = cur + step;
      setTimelineCursor(next >= max ? null : next);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setTimelineCursor(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setTimelineCursor(null);
    }
  }, [cursor, max, setTimelineCursor]);

  const isDisabled = commandCount === 0 || isReplaying;

  // ── Label ────────────────────────────────────────────────────────────────
  const stepLabel = isLive
    ? 'LIVE'
    : `Step ${sliderValue + 1} / ${commandCount}`;

  return (
    <div className="timeline-bar" role="group" aria-label="Timeline scrubber">
      <span className="timeline-bar__label">TIMELINE</span>

      <div className="timeline-bar__track">
        {/* Block-boundary tick marks */}
        {ticks.length > 0 && max > 0 && (
          <div className="timeline-bar__markers" aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.id}
                className="timeline-bar__tick"
                style={{ left: tick.left, backgroundColor: tick.color }}
              />
            ))}
          </div>
        )}

        <input
          type="range"
          className="timeline-slider"
          min={0}
          max={max}
          value={sliderValue}
          step={1}
          disabled={isDisabled}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          aria-label={`Timeline — ${stepLabel}`}
          aria-valuetext={stepLabel}
        />
      </div>

      <div className="timeline-bar__counter" aria-live="polite" aria-atomic="true">
        {commandCount > 0 ? (
          isLive
            ? <><span>{commandCount}</span> cmds</>
            : <><span>{sliderValue + 1}</span>&thinsp;/&thinsp;<span>{commandCount}</span></>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </div>
    </div>
  );
}
