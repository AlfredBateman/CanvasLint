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
  return `var(--kind-${kind})`;
}

/** Ruler spacing: a power of ten that gives at most ~100 ticks across the track. */
function tickEvery(max: number): number {
  return 10 ** Math.max(1, Math.ceil(Math.log10(Math.max(1, max) / 100)));
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

  const width = Math.max(4, String(commandCount).length);
  const pad   = (n: number) => String(n).padStart(width, '0');
  const tick  = tickEvery(max);

  // Executed range shading + ruler spacing, as percentages of the track
  const trackStyle = {
    '--pos':  max > 0 ? `${(sliderValue / max) * 100}%` : '0%',
    '--tick': max > 0 ? `${(tick / max) * 100}%` : '100%',
  } as React.CSSProperties;

  return (
    <div className="timeline-bar" role="group" aria-label="Timeline scrubber">
      <div className="timeline-bar__readout" aria-live="polite" aria-atomic="true">
        <span className={`timeline-bar__label${isLive ? '' : ' timeline-bar__label--replay'}`}>
          {isLive ? 'live' : 'replay'}
        </span>
        {commandCount > 0 ? (
          <>
            <output className="timeline-bar__step">{pad(sliderValue + 1)}</output>
            <span className="timeline-bar__total">/ {pad(commandCount)} cmd</span>
          </>
        ) : (
          <output className="timeline-bar__step timeline-bar__step--idle">{pad(0)}</output>
        )}
      </div>

      <div className="timeline-bar__track">
        {/* Block-boundary tick marks */}
        {ticks.length > 0 && max > 0 && (
          <div className="timeline-bar__markers" aria-hidden="true">
            {ticks.map((t) => (
              <span
                key={t.id}
                className="timeline-bar__tick"
                style={{ left: t.left, backgroundColor: t.color }}
              />
            ))}
          </div>
        )}

        <input
          type="range"
          className="timeline-slider"
          style={trackStyle}
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

        <div className="timeline-bar__scale" aria-hidden="true">
          <span>{isLive ? 'not replaying' : `re-executed cmd 0 → ${sliderValue}`}</span>
          <span>tick = {tick} cmd</span>
        </div>
      </div>
    </div>
  );
}
