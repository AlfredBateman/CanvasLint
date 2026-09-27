/**
 * StateInspector.tsx
 *
 * Displays the ContextStateSnapshot for the currently selected block.
 * Shows fill/stroke styles with inline swatches, transform matrix,
 * line style properties, shadow, text, and save depth.
 *
 * When no block is selected, shows a placeholder.
 */

import { usePanelStore, selectSelectedBlockState, selectSelectedBlockId } from '../usePanelStore';
import type { ContextStateSnapshot } from '../../types/render-blocks';

// ─── Swatch ──────────────────────────────────────────────────────────────────

function ColorSwatch({ color }: { color: string }) {
  const isRef = color.startsWith('<');
  if (isRef) return null;
  return (
    <span
      className="inspector-row__swatch"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function Row({
  label,
  value,
  highlight = false,
  swatch,
}: {
  label: string;
  value: string | number | boolean;
  highlight?: boolean;
  swatch?: string;
}) {
  const displayVal = typeof value === 'boolean'
    ? (value ? 'true' : 'false')
    : String(value);

  return (
    <div className={`inspector-row${highlight ? ' inspector-row--highlight' : ''}`}>
      <span className="inspector-row__key">{label}</span>
      <span className="inspector-row__val">
        {swatch && <ColorSwatch color={swatch} />}
        {displayVal}
      </span>
    </div>
  );
}

// ─── Section ─────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="inspector-section">
      <div className="inspector-section__title">{title}</div>
      {children}
    </div>
  );
}

// ─── Transform Matrix ────────────────────────────────────────────────────────

function MatrixDisplay({ t }: { t: ContextStateSnapshot['transform'] }) {
  // Display as 3×3 affine matrix:
  //  [ a  c  e ]
  //  [ b  d  f ]
  //  [ 0  0  1 ]
  const vals: Array<{ v: string; active: boolean }> = [
    { v: t.a.toFixed(3), active: t.a !== 1 },
    { v: t.c.toFixed(3), active: t.c !== 0 },
    { v: t.e.toFixed(1), active: t.e !== 0 },
    { v: t.b.toFixed(3), active: t.b !== 0 },
    { v: t.d.toFixed(3), active: t.d !== 1 },
    { v: t.f.toFixed(1), active: t.f !== 0 },
    { v: '0',            active: false },
    { v: '0',            active: false },
    { v: '1',            active: false },
  ];

  const isIdentity = t.a === 1 && t.b === 0 && t.c === 0 && t.d === 1 && t.e === 0 && t.f === 0;

  return (
    <div>
      <Row label="transform" value={isIdentity ? 'identity' : 'custom'} highlight={!isIdentity} />
      {!isIdentity && (
        <div className="matrix-grid" aria-label="Transformation matrix">
          {vals.map((cell, i) => (
            <div
              key={i}
              className={`matrix-cell${cell.active ? ' matrix-cell--active' : ''}`}
            >
              {cell.v}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Inspector ───────────────────────────────────────────────────────────

function SnapshotView({ snap }: { snap: ContextStateSnapshot }) {
  return (
    <>
      <Section title="Fill & Stroke">
        <Row label="fillStyle"   value={snap.fillStyle}   swatch={snap.fillStyle} />
        <Row label="strokeStyle" value={snap.strokeStyle} swatch={snap.strokeStyle} />
        <Row label="globalAlpha" value={snap.globalAlpha} highlight={snap.globalAlpha !== 1} />
        <Row label="composite"   value={snap.globalCompositeOperation} highlight={snap.globalCompositeOperation !== 'source-over'} />
      </Section>

      <Section title="Line Style">
        <Row label="lineWidth"      value={snap.lineWidth}      highlight={snap.lineWidth !== 1} />
        <Row label="lineCap"        value={snap.lineCap}        highlight={snap.lineCap !== 'butt'} />
        <Row label="lineJoin"       value={snap.lineJoin}       highlight={snap.lineJoin !== 'miter'} />
        <Row label="miterLimit"     value={snap.miterLimit}     highlight={snap.miterLimit !== 10} />
        <Row label="lineDash"       value={snap.lineDash.length > 0 ? `[${snap.lineDash.join(', ')}]` : '—'} highlight={snap.lineDash.length > 0} />
        <Row label="dashOffset"     value={snap.lineDashOffset} highlight={snap.lineDashOffset !== 0} />
      </Section>

      <Section title="Shadow">
        <Row label="shadowColor"   value={snap.shadowColor}   swatch={snap.shadowColor} highlight={snap.shadowBlur > 0} />
        <Row label="shadowBlur"    value={snap.shadowBlur}    highlight={snap.shadowBlur !== 0} />
        <Row label="shadowOffsetX" value={snap.shadowOffsetX} highlight={snap.shadowOffsetX !== 0} />
        <Row label="shadowOffsetY" value={snap.shadowOffsetY} highlight={snap.shadowOffsetY !== 0} />
      </Section>

      <Section title="Text">
        <Row label="font"         value={snap.font}         highlight={snap.font !== '10px sans-serif'} />
        <Row label="textAlign"    value={snap.textAlign}    highlight={snap.textAlign !== 'start'} />
        <Row label="textBaseline" value={snap.textBaseline} highlight={snap.textBaseline !== 'alphabetic'} />
      </Section>

      <Section title="Image">
        <Row label="smoothing"        value={snap.imageSmoothingEnabled} />
        <Row label="smoothingQuality" value={snap.imageSmoothingQuality} highlight={snap.imageSmoothingQuality !== 'low'} />
      </Section>

      <Section title="Transform">
        <MatrixDisplay t={snap.transform} />
        <Row label="saveDepth" value={snap.saveDepth} highlight={snap.saveDepth > 0} />
      </Section>
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export function StateInspector() {
  const selectedBlockId    = usePanelStore(selectSelectedBlockId);
  const selectedBlockState = usePanelStore(selectSelectedBlockState);

  if (selectedBlockId === null || selectedBlockState === null) {
    return (
      <div className="inspector-pane__empty">
        <div className="inspector-pane__empty-icon" aria-hidden="true">🎨</div>
        <div>Select a block to inspect its context state</div>
      </div>
    );
  }

  return (
    <div className="inspector-pane__scroll">
      <SnapshotView snap={selectedBlockState} />
    </div>
  );
}
