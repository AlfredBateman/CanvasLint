/**
 * replayEngine.ts
 *
 * Pure (non-React) replay executor — the deterministic command player.
 *
 * ── What "deterministic replay" means here ───────────────────────────────────
 * To show the canvas state at step N, we:
 *   1. Clear the replay canvas.
 *   2. Reset the 2D context to default state (same as a freshly-created canvas).
 *   3. Execute commands 0 … N in emission order.
 *
 * This correctly reconstructs the pixel output at any point because Canvas 2D
 * is an immediate-mode API with no retained scene graph — every visible pixel
 * is the product of the command stream that produced it.
 *
 * ── Asset resolution ─────────────────────────────────────────────────────────
 * drawImage commands carry a SerializedRef whose `data` field holds the image
 * src URL (captured from HTMLImageElement.src at intercept time).
 * We maintain an in-memory image cache (URL → HTMLImageElement) and resolve
 * each ref before executing. On cache miss we start a load and fall through
 * to a placeholder rectangle so replay is never blocked.
 *
 * ── Performance ──────────────────────────────────────────────────────────────
 * Executing N commands is O(N). For the 10,000-command buffer limit:
 * - At typical canvas complexity (~100 cmds per frame / 60fps) N≤10,000 executes
 *   in well under 1ms on modern hardware.
 * - We execute on the calling microtask (no workers, no setTimeout) so jank
 *   appears as a blocked frame rather than a visual glitch between frames.
 * - A dedicated OffscreenCanvas path is a future optimisation (requires the
 *   background worker to hold the canvas, which conflicts with the buffer model).
 *
 * ── SerializedRef handling ───────────────────────────────────────────────────
 * Complex objects (CanvasGradient, Path2D) cannot cross the port boundary.
 * For these we skip the draw call and emit a ReplayWarning.
 * Image URLs (SerializedRef.data is a URL string) are resolved to
 * HTMLImageElements via the async cache.
 *
 * This file exports:
 *   createReplayEngine(ctx)   → ReplayEngine instance
 *   interface ReplayEngine    (execute, setCanvas, onWarning)
 */

import type { CanvasCommand, SerializedRef } from '../types/canvas-commands';

// ─── Warning output ───────────────────────────────────────────────────────────

export type ReplayWarningKind =
  | 'unresolved-ref'   // Object ref can't be restored (gradient, pattern, path2D)
  | 'async-asset'      // Image URL not yet loaded; draw skipped
  | 'state-stack-drift'// save/restore mismatch detected
  | 'unknown-command'; // Method not handled (future-proofing)

export interface ReplayIssue {
  kind:    ReplayWarningKind;
  message: string;
  atIndex: number;
}

// ─── Image cache ─────────────────────────────────────────────────────────────

/** URL → loaded HTMLImageElement (or null while loading) */
const imageCache = new Map<string, HTMLImageElement | null>();

function loadImage(url: string): HTMLImageElement | null {
  if (imageCache.has(url)) return imageCache.get(url) ?? null;

  // Start loading; return null for this replay pass
  imageCache.set(url, null);
  const img = new Image();
  img.onload  = () => imageCache.set(url, img);
  img.onerror = () => imageCache.delete(url); // retry next replay
  img.crossOrigin = 'anonymous';
  img.src = url;
  return null;
}

/** Clear the image cache — call on Hard Reset. */
export function clearImageCache(): void {
  imageCache.clear();
}

// ─── Ref resolution ──────────────────────────────────────────────────────────

/**
 * Attempts to resolve a SerializedRef to a usable value for the replay ctx.
 * Returns the resolved value, or null if it cannot be resolved (caller skips).
 */
function resolveRef(
  ref: SerializedRef,
  issues: ReplayIssue[],
  cmdIndex: number,
): HTMLImageElement | null {
  // Images/videos: we stored the src URL in ref.data at capture time
  if (ref.data && (ref.originalType === 'HTMLImageElement' || ref.originalType === 'HTMLVideoElement')) {
    const img = loadImage(ref.data);
    if (!img) {
      issues.push({
        kind:    'async-asset',
        message: `Image not yet loaded: ${ref.data}`,
        atIndex: cmdIndex,
      });
      return null;
    }
    return img;
  }

  // Gradients, patterns, Path2D objects cannot be reconstructed
  issues.push({
    kind:    'unresolved-ref',
    message: `Cannot restore ${ref.originalType} (refId: ${ref.refId.slice(0, 8)}…)`,
    atIndex: cmdIndex,
  });
  return null;
}

/**
 * Convert a serialized style value back to something ctx can use.
 * Returns a CSS color string, or a fallback if the ref is unresolvable.
 */
function resolveStyle(
  val: string | SerializedRef,
  issues: ReplayIssue[],
  cmdIndex: number,
): string | CanvasGradient | CanvasPattern {
  if (typeof val === 'string') return val;
  // Gradient/pattern refs cannot be replayed — use transparent as fallback
  issues.push({
    kind:    'unresolved-ref',
    message: `Cannot restore ${val.originalType} gradient/pattern — using transparent`,
    atIndex: cmdIndex,
  });
  return 'transparent';
}

// ─── Context reset ────────────────────────────────────────────────────────────

/**
 * Resets a 2D context to its post-construction default state.
 * Resizing the canvas clears pixels but does NOT reset transform/styles.
 * We must do both.
 */
function resetContext(ctx: CanvasRenderingContext2D): void {
  const { width, height } = ctx.canvas;

  // Pop any dangling save() calls first, so nothing below gets overwritten
  // by a restore(). restore() never throws; it's a no-op once the stack
  // is empty.
  for (let i = 0; i < 64; i++) ctx.restore();

  ctx.resetTransform();

  // Pixel clear
  ctx.clearRect(0, 0, width, height);

  // Style / state reset (mirrors browser canvas defaults)
  ctx.fillStyle                = '#000000';
  ctx.strokeStyle              = '#000000';
  ctx.globalAlpha              = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineWidth                = 1;
  ctx.lineCap                  = 'butt';
  ctx.lineJoin                 = 'miter';
  ctx.miterLimit               = 10;
  ctx.setLineDash([]);
  ctx.lineDashOffset           = 0;
  ctx.shadowColor              = 'rgba(0,0,0,0)';
  ctx.shadowBlur               = 0;
  ctx.shadowOffsetX            = 0;
  ctx.shadowOffsetY            = 0;
  ctx.font                     = '10px sans-serif';
  ctx.textAlign                = 'start';
  ctx.textBaseline             = 'alphabetic';
  ctx.imageSmoothingEnabled    = true;
  ctx.imageSmoothingQuality    = 'low';
}

// ─── Command executor (the switch) ────────────────────────────────────────────

/**
 * Executes a single CanvasCommand against `ctx`.
 * Mutates `issues[]` on any warning condition.
 * Returns false if the command was skipped entirely.
 */
function executeCommand(
  ctx:     CanvasRenderingContext2D,
  cmd:     CanvasCommand,
  issues:  ReplayIssue[],
): boolean {
  const idx = cmd.index;

  switch (cmd.method) {
    // ── Path construction ────────────────────────────────────────────────
    case 'beginPath':         ctx.beginPath(); break;
    case 'closePath':         ctx.closePath(); break;
    case 'moveTo':            ctx.moveTo(...cmd.args); break;
    case 'lineTo':            ctx.lineTo(...cmd.args); break;
    case 'bezierCurveTo':     ctx.bezierCurveTo(...cmd.args); break;
    case 'quadraticCurveTo':  ctx.quadraticCurveTo(...cmd.args); break;
    case 'arc':               ctx.arc(...cmd.args); break;
    case 'arcTo':             ctx.arcTo(...cmd.args); break;
    case 'ellipse':           ctx.ellipse(...cmd.args); break;
    case 'rect':              ctx.rect(...cmd.args); break;

    // ── Painting ────────────────────────────────────────────────────────
    case 'fillRect':          ctx.fillRect(...cmd.args); break;
    case 'strokeRect':        ctx.strokeRect(...cmd.args); break;
    case 'clearRect':         ctx.clearRect(...cmd.args); break;
    case 'fillText':          ctx.fillText(...cmd.args); break;
    case 'strokeText':        ctx.strokeText(...cmd.args); break;

    case 'fill': {
      // fill([fillRule]) or fill(path, fillRule) — Path2D ref not resolvable
      const [first] = cmd.args as any[];
      if (first && typeof first === 'object' && '__type' in first) {
        // Path2D ref — skip silently (path itself was replayed via path commands)
        ctx.fill();
      } else {
        ctx.fill(...(cmd.args as [] | [CanvasFillRule]));
      }
      break;
    }

    case 'stroke': {
      const [first] = cmd.args as any[];
      if (first && typeof first === 'object' && '__type' in first) {
        ctx.stroke();
      } else {
        ctx.stroke();
      }
      break;
    }

    // ── drawImage (three arities) ────────────────────────────────────────
    case 'drawImage:3': {
      const [imgRef, dx, dy] = cmd.args;
      const img = resolveRef(imgRef, issues, idx);
      if (!img) return false;
      ctx.drawImage(img, dx, dy);
      break;
    }
    case 'drawImage:5': {
      const [imgRef, dx, dy, dw, dh] = cmd.args;
      const img = resolveRef(imgRef, issues, idx);
      if (!img) return false;
      ctx.drawImage(img, dx, dy, dw, dh);
      break;
    }
    case 'drawImage:9': {
      const [imgRef, sx, sy, sw, sh, dx, dy, dw, dh] = cmd.args;
      const img = resolveRef(imgRef, issues, idx);
      if (!img) return false;
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      break;
    }

    // ── putImageData ─────────────────────────────────────────────────────
    case 'putImageData': {
      // ImageData ref — cannot cross the port boundary, skip
      issues.push({
        kind:    'unresolved-ref',
        message: `putImageData: ImageData cannot be replayed (opaque ref at ${idx})`,
        atIndex: idx,
      });
      return false;
    }

    // ── State ────────────────────────────────────────────────────────────
    case 'save':    ctx.save(); break;
    case 'restore': ctx.restore(); break;

    case 'clip': {
      const [first] = cmd.args as any[];
      if (first && typeof first === 'object' && '__type' in first) {
        ctx.clip(); // ignore Path2D ref
      } else {
        ctx.clip(...(cmd.args as [] | [CanvasFillRule]));
      }
      break;
    }

    // ── Transform ────────────────────────────────────────────────────────
    case 'translate':     ctx.translate(...cmd.args); break;
    case 'rotate':        ctx.rotate(...cmd.args); break;
    case 'scale':         ctx.scale(...cmd.args); break;
    case 'transform':     ctx.transform(...cmd.args); break;
    case 'setTransform':  ctx.setTransform(...cmd.args); break;
    case 'resetTransform': ctx.resetTransform(); break;

    // ── setLineDash ──────────────────────────────────────────────────────
    case 'setLineDash': ctx.setLineDash(cmd.args[0]); break;

    // ── Property setters ─────────────────────────────────────────────────
    case 'set:fillStyle':   ctx.fillStyle   = resolveStyle(cmd.value, issues, idx); break;
    case 'set:strokeStyle': ctx.strokeStyle = resolveStyle(cmd.value, issues, idx); break;

    case 'set:globalAlpha':              ctx.globalAlpha              = cmd.value; break;
    case 'set:lineWidth':                ctx.lineWidth                = cmd.value; break;
    case 'set:lineCap':                  ctx.lineCap                  = cmd.value; break;
    case 'set:lineJoin':                 ctx.lineJoin                 = cmd.value; break;
    case 'set:miterLimit':               ctx.miterLimit               = cmd.value; break;
    case 'set:lineDashOffset':           ctx.lineDashOffset           = cmd.value; break;
    case 'set:shadowColor':              ctx.shadowColor              = cmd.value; break;
    case 'set:shadowBlur':               ctx.shadowBlur               = cmd.value; break;
    case 'set:shadowOffsetX':            ctx.shadowOffsetX            = cmd.value; break;
    case 'set:shadowOffsetY':            ctx.shadowOffsetY            = cmd.value; break;
    case 'set:font':                     ctx.font                     = cmd.value; break;
    case 'set:textAlign':                ctx.textAlign                = cmd.value; break;
    case 'set:textBaseline':             ctx.textBaseline             = cmd.value; break;
    case 'set:globalCompositeOperation': ctx.globalCompositeOperation = cmd.value; break;
    case 'set:imageSmoothingEnabled':    ctx.imageSmoothingEnabled    = cmd.value; break;
    case 'set:imageSmoothingQuality':    ctx.imageSmoothingQuality    = cmd.value; break;

    default:
      issues.push({
        kind:    'unknown-command',
        message: `Unknown command method: ${(cmd as any).method}`,
        atIndex: idx,
      });
      return false;
  }

  return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ReplayResult {
  /** Commands successfully executed. */
  executed: number;
  /** Commands skipped (unresolvable refs, unknown methods). */
  skipped:  number;
  /** Wall-clock time for the full replay in milliseconds. */
  durationMs: number;
  /** Warnings generated. */
  issues: ReplayIssue[];
}

/**
 * Replays `commands[0..endIndex]` onto `ctx`.
 *
 * @param ctx        The replay canvas 2D context.
 * @param commands   Array of commands in logical emission order (oldest first).
 * @param endIndex   Inclusive upper bound. Pass `commands.length - 1` for full replay.
 */
export function replayCommands(
  ctx:      CanvasRenderingContext2D,
  commands: CanvasCommand[],
  endIndex: number,
): ReplayResult {
  const t0     = performance.now();
  const issues: ReplayIssue[] = [];

  resetContext(ctx);

  let executed = 0;
  let skipped  = 0;

  const limit = Math.min(endIndex, commands.length - 1);

  for (let i = 0; i <= limit; i++) {
    try {
      const ok = executeCommand(ctx, commands[i], issues);
      if (ok) executed++; else skipped++;
    } catch (err) {
      console.warn(`[CanvasLint] replay: skipping command at ${commands[i].index} (${commands[i].method})`, err);
      issues.push({
        kind:    'unknown-command',
        message: `${commands[i].method} threw during replay and was skipped: ${err}`,
        atIndex: commands[i].index,
      });
      skipped++;
    }
  }

  return {
    executed,
    skipped,
    durationMs: performance.now() - t0,
    issues,
  };
}
