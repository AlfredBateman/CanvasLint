/**
 * canvas-commands.ts
 *
 * Discriminated union of every interceptable CanvasRenderingContext2D command.
 *
 * Design decisions:
 * - Each command is a tagged variant (discriminated on `method`) so downstream
 *   consumers can switch/match exhaustively with no casts.
 * - Arguments are typed as flat tuples — matching the actual JS call signature —
 *   so the proxy can spread them directly: `ctx[cmd.method](...cmd.args)`.
 * - Property *mutations* (e.g. `ctx.fillStyle = '…'`) are modelled as
 *   `set:<prop>` commands rather than method calls, because setter interception
 *   requires a different proxy path (defineProperty) than method wrapping.
 * - `drawImage` has three legal overload arities (3, 5, 9 args). We model each
 *   as a separate variant rather than using a union of tuple lengths, so the
 *   replay engine can branch without runtime arity checks.
 * - Complex non-serialisable objects (CanvasGradient, CanvasPattern, Path2D,
 *   ImageData) are replaced by an opaque `SerializedRef` handle. See the
 *   Engineering Trade-offs section of the PRD — we accept replay inaccuracy for
 *   these types in exchange for a JSON-serialisable command stream.
 *
 * Coverage:
 *   Path construction  → beginPath, closePath, moveTo, lineTo,
 *                        bezierCurveTo, quadraticCurveTo, arc, arcTo,
 *                        ellipse, rect
 *   Painting           → fill, stroke, fillRect, strokeRect, clearRect,
 *                        fillText, strokeText, drawImage (×3 overloads)
 *   State              → save, restore, clip
 *   Transform          → translate, rotate, scale, transform,
 *                        setTransform, resetTransform
 *   Property setters   → fillStyle, strokeStyle, globalAlpha, lineWidth,
 *                        lineCap, lineJoin, miterLimit, lineDash,
 *                        lineDashOffset, shadowColor, shadowBlur,
 *                        shadowOffsetX, shadowOffsetY, font, textAlign,
 *                        textBaseline, globalCompositeOperation,
 *                        imageSmoothingEnabled, imageSmoothingQuality
 */

// ─── Supporting primitives ─────────────────────────────────────────────────

/** Monotonic DOMHighResTimeStamp from performance.now() at capture time. */
export type Timestamp = number;

/**
 * 0-based ordinal position of this command within the logical capture session.
 * Persists across circular-buffer wraps (never resets) so the timeline always
 * increases monotonically.
 */
export type CommandIndex = number;

/**
 * Opaque reference token for non-serialisable objects (CanvasGradient,
 * CanvasPattern, Path2D, ImageData, HTMLImageElement, etc.).
 *
 * During capture the proxy stores the live object in a WeakMap keyed by this
 * token. During replay the engine looks the token up and uses the stored object
 * directly. If the object has been GC'd (or is cross-origin) the engine treats
 * the command as a no-op and emits a `ReplayWarning`.
 */
export interface SerializedRef {
  readonly __type: 'SerializedRef';
  readonly refId: string; // UUID v4
  readonly originalType: string; // e.g. "CanvasGradient" | "ImageData"
  readonly data?: string; // e.g. image.src so DevTools can load the asset
}

export type SerializedStyle = string | SerializedRef; // color string or gradient/pattern ref

/** Subset of the DOMMatrix values needed for transform snapshots. */
export interface SerializedDOMMatrix {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

// ─── Command base ──────────────────────────────────────────────────────────

/** Fields shared by every intercepted event. */
interface CommandBase {
  /** Discriminant — the exact method name or `set:<prop>` for property writes. */
  readonly method: string;
  /** Capture-time performance.now() value. */
  readonly timestamp: Timestamp;
  /** Monotonically increasing ordinal within the current recording session. */
  readonly index: CommandIndex;
  /**
   * Index of the <canvas> element on the page, to disambiguate multi-canvas
   * documents. Derived from document.querySelectorAll('canvas').
   */
  readonly canvasId: number;
}

// ─── Path construction ─────────────────────────────────────────────────────

export interface BeginPathCommand      extends CommandBase { method: 'beginPath';      args: [] }
export interface ClosePathCommand      extends CommandBase { method: 'closePath';      args: [] }
export interface MoveToCommand         extends CommandBase { method: 'moveTo';         args: [x: number, y: number] }
export interface LineToCommand         extends CommandBase { method: 'lineTo';         args: [x: number, y: number] }
export interface BezierCurveToCommand  extends CommandBase { method: 'bezierCurveTo';  args: [cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number] }
export interface QuadraticCurveToCommand extends CommandBase { method: 'quadraticCurveTo'; args: [cpx: number, cpy: number, x: number, y: number] }
export interface ArcCommand            extends CommandBase { method: 'arc';            args: [x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean] }
export interface ArcToCommand          extends CommandBase { method: 'arcTo';          args: [x1: number, y1: number, x2: number, y2: number, radius: number] }
export interface EllipseCommand        extends CommandBase { method: 'ellipse';        args: [x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number, counterclockwise?: boolean] }
export interface RectCommand           extends CommandBase { method: 'rect';           args: [x: number, y: number, w: number, h: number] }

// ─── Painting ──────────────────────────────────────────────────────────────

/** fill() accepts an optional non-zero fill rule. */
export interface FillCommand             extends CommandBase { method: 'fill';           args: [] | [fillRule: CanvasFillRule] | [path: SerializedRef, fillRule?: CanvasFillRule] }
export interface StrokeCommand           extends CommandBase { method: 'stroke';         args: [] | [path: SerializedRef] }
export interface FillRectCommand         extends CommandBase { method: 'fillRect';       args: [x: number, y: number, w: number, h: number] }
export interface StrokeRectCommand       extends CommandBase { method: 'strokeRect';     args: [x: number, y: number, w: number, h: number] }
export interface ClearRectCommand        extends CommandBase { method: 'clearRect';      args: [x: number, y: number, w: number, h: number] }
export interface FillTextCommand         extends CommandBase { method: 'fillText';       args: [text: string, x: number, y: number, maxWidth?: number] }
export interface StrokeTextCommand       extends CommandBase { method: 'strokeText';     args: [text: string, x: number, y: number, maxWidth?: number] }

/**
 * drawImage has three distinct overloads. We model them as separate command
 * variants so replay branches cleanly without runtime arity inspection.
 */
export interface DrawImage3Command extends CommandBase {
  method: 'drawImage:3';
  args: [image: SerializedRef, dx: number, dy: number];
}
export interface DrawImage5Command extends CommandBase {
  method: 'drawImage:5';
  args: [image: SerializedRef, dx: number, dy: number, dw: number, dh: number];
}
export interface DrawImage9Command extends CommandBase {
  method: 'drawImage:9';
  args: [image: SerializedRef, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number];
}

export interface PutImageDataCommand extends CommandBase {
  method: 'putImageData';
  args: [imageData: SerializedRef, dx: number, dy: number] | [imageData: SerializedRef, dx: number, dy: number, dirtyX: number, dirtyY: number, dirtyWidth: number, dirtyHeight: number];
}

// ─── State management ──────────────────────────────────────────────────────

export interface SaveCommand             extends CommandBase { method: 'save';           args: [] }
export interface RestoreCommand          extends CommandBase { method: 'restore';        args: [] }
export interface ClipCommand             extends CommandBase { method: 'clip';           args: [] | [fillRule: CanvasFillRule] | [path: SerializedRef, fillRule?: CanvasFillRule] }

// ─── Transform ─────────────────────────────────────────────────────────────

export interface TranslateCommand        extends CommandBase { method: 'translate';      args: [x: number, y: number] }
export interface RotateCommand           extends CommandBase { method: 'rotate';         args: [angle: number] }
export interface ScaleCommand            extends CommandBase { method: 'scale';          args: [x: number, y: number] }
export interface TransformCommand        extends CommandBase { method: 'transform';      args: [a: number, b: number, c: number, d: number, e: number, f: number] }
export interface SetTransformCommand     extends CommandBase { method: 'setTransform';   args: [a: number, b: number, c: number, d: number, e: number, f: number] }
export interface ResetTransformCommand   extends CommandBase { method: 'resetTransform'; args: [] }

// ─── setLineDash (method, not setter) ─────────────────────────────────────

export interface SetLineDashCommand      extends CommandBase { method: 'setLineDash';    args: [segments: number[]] }

// ─── Property setters (ctx.<prop> = value) ────────────────────────────────

interface SetterBase extends CommandBase { method: `set:${string}` }

export interface SetFillStyleCommand            extends SetterBase { method: 'set:fillStyle';             value: SerializedStyle }
export interface SetStrokeStyleCommand          extends SetterBase { method: 'set:strokeStyle';           value: SerializedStyle }
export interface SetGlobalAlphaCommand          extends SetterBase { method: 'set:globalAlpha';           value: number }
export interface SetLineWidthCommand            extends SetterBase { method: 'set:lineWidth';             value: number }
export interface SetLineCapCommand              extends SetterBase { method: 'set:lineCap';               value: CanvasLineCap }
export interface SetLineJoinCommand             extends SetterBase { method: 'set:lineJoin';              value: CanvasLineJoin }
export interface SetMiterLimitCommand           extends SetterBase { method: 'set:miterLimit';            value: number }
export interface SetLineDashOffsetCommand       extends SetterBase { method: 'set:lineDashOffset';        value: number }
export interface SetShadowColorCommand          extends SetterBase { method: 'set:shadowColor';           value: string }
export interface SetShadowBlurCommand           extends SetterBase { method: 'set:shadowBlur';            value: number }
export interface SetShadowOffsetXCommand        extends SetterBase { method: 'set:shadowOffsetX';         value: number }
export interface SetShadowOffsetYCommand        extends SetterBase { method: 'set:shadowOffsetY';         value: number }
export interface SetFontCommand                 extends SetterBase { method: 'set:font';                  value: string }
export interface SetTextAlignCommand            extends SetterBase { method: 'set:textAlign';             value: CanvasTextAlign }
export interface SetTextBaselineCommand         extends SetterBase { method: 'set:textBaseline';          value: CanvasTextBaseline }
export interface SetGlobalCompositeOpCommand    extends SetterBase { method: 'set:globalCompositeOperation'; value: GlobalCompositeOperation }
export interface SetImageSmoothingEnabledCommand extends SetterBase { method: 'set:imageSmoothingEnabled'; value: boolean }
export interface SetImageSmoothingQualityCommand extends SetterBase { method: 'set:imageSmoothingQuality'; value: ImageSmoothingQuality }

// ─── Master union ──────────────────────────────────────────────────────────

/** All intercepted path-construction commands. */
export type PathCommand =
  | BeginPathCommand | ClosePathCommand | MoveToCommand | LineToCommand
  | BezierCurveToCommand | QuadraticCurveToCommand | ArcCommand | ArcToCommand
  | EllipseCommand | RectCommand;

/** All commands that terminates an open path (used by the grouping parser). */
export type PathTerminatorCommand = FillCommand | StrokeCommand;

/** All commands that rasterise pixels (path terminators + direct rect/text/image draws). */
export type PaintCommand =
  | PathTerminatorCommand
  | FillRectCommand | StrokeRectCommand | ClearRectCommand
  | FillTextCommand | StrokeTextCommand
  | DrawImage3Command | DrawImage5Command | DrawImage9Command
  | PutImageDataCommand;

/** All property-setter commands. */
export type SetterCommand =
  | SetFillStyleCommand | SetStrokeStyleCommand | SetGlobalAlphaCommand
  | SetLineWidthCommand | SetLineCapCommand | SetLineJoinCommand
  | SetMiterLimitCommand | SetLineDashOffsetCommand | SetLineDashCommand
  | SetShadowColorCommand | SetShadowBlurCommand
  | SetShadowOffsetXCommand | SetShadowOffsetYCommand
  | SetFontCommand | SetTextAlignCommand | SetTextBaselineCommand
  | SetGlobalCompositeOpCommand | SetImageSmoothingEnabledCommand
  | SetImageSmoothingQualityCommand;

/** All intercepted transform commands. */
export type TransformCommand_ =
  | TranslateCommand | RotateCommand | ScaleCommand
  | TransformCommand | SetTransformCommand | ResetTransformCommand;

/** All intercepted state commands. */
export type StateCommand = SaveCommand | RestoreCommand | ClipCommand;

/**
 * The complete discriminated union of every command the proxy can emit.
 * Downstream consumers should switch on `command.method`.
 */
export type CanvasCommand =
  | PathCommand
  | PaintCommand
  | StateCommand
  | TransformCommand_
  | SetLineDashCommand
  | SetterCommand;

/** Extract the method string literal type from a command variant. */
export type CanvasCommandMethod = CanvasCommand['method'];

// ─── Method name sets (runtime constants mirroring the union) ─────────────

/** Methods that open a new path segment. Used by the grouping parser. */
export const PATH_OPENER_METHODS = new Set<CanvasCommandMethod>(['beginPath']);

/** Methods that close/rasterise a path. Used by the grouping parser. */
export const PATH_TERMINATOR_METHODS = new Set<CanvasCommandMethod>([
  'fill', 'stroke',
]);

/** Methods that rasterise without an explicit beginPath. */
export const DIRECT_PAINT_METHODS = new Set<CanvasCommandMethod>([
  'fillRect', 'strokeRect', 'clearRect',
  'fillText', 'strokeText',
  'drawImage:3', 'drawImage:5', 'drawImage:9',
  'putImageData',
]);
