/**
 * render-blocks.ts
 *
 * Types for the "Logical Command Grouping" feature (formerly "Virtual Layers").
 *
 * From the PRD (§2 — Logical Command Grouping):
 *   "Any sequence of commands bounded by `beginPath()` and ending with
 *    `fill()` or `stroke()` is treated as a single selectable UI block."
 *
 * This file models:
 *   1. The atomic membership of a command within a block.
 *   2. The parsed RenderBlock structure itself.
 *   3. The two parse strategies: path-bounded blocks and direct-paint singletons.
 *   4. The parser's output and incremental state.
 *
 * Parser algorithm (stateful, O(n) single-pass):
 *   - Maintain a nullable `openBlock` accumulator.
 *   - On `beginPath`:  open a new accumulator (close any dangling open block first).
 *   - On path command: if accumulator is open, push to it; otherwise emit a
 *     StandaloneCommand (the path command appeared outside a beginPath context).
 *   - On `fill`/`stroke`: if accumulator is open → seal it as a PathBlock,
 *     reset accumulator; otherwise emit a StandaloneCommand.
 *   - On a direct-paint method (fillRect, fillText, drawImage…):
 *     emit an ImmediatePaintBlock immediately (no accumulator interaction).
 *   - On any setter/transform/state command: push to the open accumulator's
 *     `precedingSetters` list OR emit a LooseSetterCommand if accumulator is null.
 */

import type {
  CanvasCommand,
  CanvasCommandMethod,
  CommandIndex,
  PathTerminatorCommand,
  PaintCommand,
  SetterCommand,
  TransformCommand_,
  StateCommand,
} from './canvas-commands';

// ─── Block identity ────────────────────────────────────────────────────────

/** Stable, monotonically increasing integer ID assigned at parse time. */
export type BlockId = number;

// ─── Shared block metadata ─────────────────────────────────────────────────

/**
 * Properties common to every block variant.
 * `startIndex` / `endIndex` are indices into the flat CommandBuffer —
 * they can be used to slice the buffer for replay without storing a
 * redundant copy of the commands inside the block.
 */
interface BlockBase {
  /** Unique monotonic identifier for this block within the current session. */
  readonly id: BlockId;

  /**
   * CommandIndex of the first command that belongs to this block.
   * For a PathBlock this is the `beginPath` command.
   * For an ImmediatePaintBlock this is the paint command itself.
   */
  readonly startIndex: CommandIndex;

  /**
   * CommandIndex of the last command that belongs to this block.
   * For a PathBlock this is the `fill` or `stroke` command.
   */
  readonly endIndex: CommandIndex;

  /** Human-readable label synthesised by the parser for the UI list view. */
  readonly label: string;
}

// ─── Block variants ────────────────────────────────────────────────────────

/**
 * A block bounded by `beginPath()` … `fill()` | `stroke()`.
 * This is the primary unit of logical grouping per the PRD.
 *
 * The `pathCommands` list contains the geometric construction commands
 * (moveTo, lineTo, arc, …) in capture order, excluding the opening
 * `beginPath` and the closing terminator, for convenience during highlight.
 *
 * `precedingSetters` captures all setter/transform/state commands that were
 * issued *after the previous block closed and before this block's beginPath*.
 * They are replayed before this block's path commands to ensure correct state.
 */
export interface PathBlock extends BlockBase {
  readonly kind: 'path';
  /** The `beginPath` command that opened this block. */
  readonly opener: CanvasCommand & { method: 'beginPath' };
  /** Geometric construction commands between beginPath and the terminator. */
  readonly pathCommands: CanvasCommand[];
  /** The `fill` or `stroke` command that sealed this block. */
  readonly terminator: PathTerminatorCommand;
  /**
   * Setter / transform / state commands that immediately preceded this block
   * (after the last block's terminator). Must be replayed first.
   */
  readonly precedingSetters: (SetterCommand | TransformCommand_ | StateCommand)[];
  /**
   * A snapshot of the context's serialisable state at the moment this block
   * was sealed. Used by the Live State Inspector without re-running replay.
   */
  readonly stateSnapshot: ContextStateSnapshot;
}

/**
 * A single direct-paint command that rasterises without an explicit path
 * (fillRect, fillText, drawImage, putImageData, strokeRect, clearRect).
 *
 * These are treated as atomic single-command blocks rather than being merged
 * into adjacent PathBlocks, because they have no open/close lifecycle.
 */
export interface ImmediatePaintBlock extends BlockBase {
  readonly kind: 'immediate';
  readonly command: PaintCommand;
  readonly precedingSetters: (SetterCommand | TransformCommand_ | StateCommand)[];
  readonly stateSnapshot: ContextStateSnapshot;
}

/**
 * Setter, transform, or state commands that appear in a region with no
 * surrounding path or immediate-paint block. We still track them so the
 * timeline is complete, but they are rendered with a muted style in the UI.
 *
 * Example: a `ctx.save()` called at the top-level before any drawing has begun.
 */
export interface LooseCommand extends BlockBase {
  readonly kind: 'loose';
  readonly command: SetterCommand | TransformCommand_ | StateCommand;
}

/** Union of all block types emitted by the parser. */
export type RenderBlock = PathBlock | ImmediatePaintBlock | LooseCommand;

/** Convenience narrowing helpers. */
export const isPathBlock          = (b: RenderBlock): b is PathBlock          => b.kind === 'path';
export const isImmediatePaintBlock = (b: RenderBlock): b is ImmediatePaintBlock => b.kind === 'immediate';
export const isLooseCommand       = (b: RenderBlock): b is LooseCommand       => b.kind === 'loose';

// ─── Context state snapshot ────────────────────────────────────────────────

/**
 * A serialisable snapshot of all observable context properties at a
 * given point in the command stream.
 *
 * Used by:
 *   - The Live State Inspector to display current style values.
 *   - The `stateSnapshot` field on each committed block.
 *
 * We snapshot only the properties exposed by the setter commands we intercept.
 * Non-intercepted properties (e.g., the current path geometry) are not included.
 *
 * All values are primitives or strings — guaranteed JSON-serialisable.
 */
export interface ContextStateSnapshot {
  // ── Fill & stroke ──────────────────────────────────────────────────────
  fillStyle:   string; // resolved to a CSS color string; refs become '<gradient>'/'<pattern>'
  strokeStyle: string;

  // ── Compositing ────────────────────────────────────────────────────────
  globalAlpha:              number;
  globalCompositeOperation: GlobalCompositeOperation;

  // ── Line style ─────────────────────────────────────────────────────────
  lineWidth:      number;
  lineCap:        CanvasLineCap;
  lineJoin:       CanvasLineJoin;
  miterLimit:     number;
  lineDash:       number[];  // snapshot of getLineDash()
  lineDashOffset: number;

  // ── Shadow ─────────────────────────────────────────────────────────────
  shadowColor:   string;
  shadowBlur:    number;
  shadowOffsetX: number;
  shadowOffsetY: number;

  // ── Text ───────────────────────────────────────────────────────────────
  font:         string;
  textAlign:    CanvasTextAlign;
  textBaseline: CanvasTextBaseline;

  // ── Image rendering ────────────────────────────────────────────────────
  imageSmoothingEnabled: boolean;
  imageSmoothingQuality: ImageSmoothingQuality;

  // ── Transform ──────────────────────────────────────────────────────────
  /** The current transformation matrix as a 6-value DOMMatrix decomposition. */
  transform: { a: number; b: number; c: number; d: number; e: number; f: number };

  /** Current save/restore nesting depth. Used to detect stack drift (§5). */
  saveDepth: number;
}

/** The initial context state — mirrors the browser's canvas defaults. */
export const DEFAULT_CONTEXT_STATE: Readonly<ContextStateSnapshot> = {
  fillStyle:                '#000000',
  strokeStyle:              '#000000',
  globalAlpha:              1,
  globalCompositeOperation: 'source-over',
  lineWidth:                1,
  lineCap:                  'butt',
  lineJoin:                 'miter',
  miterLimit:               10,
  lineDash:                 [],
  lineDashOffset:           0,
  shadowColor:              'rgba(0, 0, 0, 0)',
  shadowBlur:               0,
  shadowOffsetX:            0,
  shadowOffsetY:            0,
  font:                     '10px sans-serif',
  textAlign:                'start',
  textBaseline:             'alphabetic',
  imageSmoothingEnabled:    true,
  imageSmoothingQuality:    'low',
  transform:                { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
  saveDepth:                0,
} as const;

// ─── Parser state ──────────────────────────────────────────────────────────

/**
 * Mutable internal state used by the incremental block parser.
 * Exposed as a type so it can be initialised, serialised for debugging,
 * or reset by the "Hard Reset & Resync" action (§5).
 */
export interface BlockParserState {
  /** Next block id to assign. Increments per committed block. */
  nextBlockId: BlockId;

  /**
   * Commands accumulated since the last `beginPath` but before a terminator.
   * Null when no path is open.
   */
  openBlock: {
    openedAtIndex: CommandIndex;
    opener: CanvasCommand & { method: 'beginPath' };
    pathCommands: CanvasCommand[];
    precedingSetters: (SetterCommand | TransformCommand_ | StateCommand)[];
  } | null;

  /**
   * Setters/transforms/state commands seen since the last terminated block
   * but before any new `beginPath`. Flushed into the next block's
   * `precedingSetters` or emitted as LooseCommands on reset.
   */
  pendingSetters: (SetterCommand | TransformCommand_ | StateCommand)[];

  /** Running snapshot of context state, updated by each setter command. */
  currentState: ContextStateSnapshot;
}

/** Returns a fresh parser state with browser-default context values. */
export function createInitialParserState(): BlockParserState {
  return {
    nextBlockId:    0,
    openBlock:      null,
    pendingSetters: [],
    currentState:   { ...DEFAULT_CONTEXT_STATE },
  };
}

// ─── Parser output ─────────────────────────────────────────────────────────

/**
 * Result of parsing a single incoming CanvasCommand.
 * The parser emits zero or more blocks per command (usually 0 or 1,
 * but a dangling `beginPath` recovery can emit a LooseCommand + open a new block).
 */
export interface ParseResult {
  /** Newly committed blocks, in emission order. May be empty. */
  readonly committed: RenderBlock[];
  /**
   * If true, the current `openBlock` was forcibly closed due to an unexpected
   * `beginPath` (nested beginPath without a terminator). The UI should display
   * a warning icon on the affected block.
   */
  readonly hadDanglingPath: boolean;
}

// ─── Label generation helpers ──────────────────────────────────────────────

/**
 * Returns a concise human-readable label for a new block.
 * Consumed by the parser when committing a block.
 *
 * Examples:
 *   pathBlockLabel('fill', ['arc'])         → "arc → fill"
 *   pathBlockLabel('stroke', ['moveTo', 'lineTo', 'lineTo']) → "path(3) → stroke"
 *   immediatePaintLabel('fillRect')         → "fillRect"
 *   immediatePaintLabel('drawImage:3')      → "drawImage"
 */
export function pathBlockLabel(
  terminator: 'fill' | 'stroke',
  pathMethods: CanvasCommandMethod[],
): string {
  if (pathMethods.length === 1) return `${pathMethods[0]} → ${terminator}`;
  if (pathMethods.length <= 3)  return `${pathMethods.join(', ')} → ${terminator}`;
  return `path(${pathMethods.length}) → ${terminator}`;
}

export function immediatePaintLabel(method: CanvasCommandMethod): string {
  // Normalise drawImage:3/5/9 → "drawImage"
  return method.startsWith('drawImage') ? 'drawImage' : method;
}
