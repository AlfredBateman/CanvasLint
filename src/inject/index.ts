/**
 * CanvasLint Injection Script — MAIN world
 *
 * Intercepts CanvasRenderingContext2D methods and property setters.
 *
 * ── Batching strategy ────────────────────────────────────────────────────────
 * Canvas apps routinely issue thousands of draw calls per second. Naive
 * per-call postMessage would saturate the structured-clone pipeline and cause
 * jank in the host page (violating the PRD ≤15% frame-time budget).
 *
 * Instead, we collect intercepted commands into a micro-queue and drain it
 * exactly once per animation frame via requestAnimationFrame. At 60 fps the
 * content script receives at most 60 postMessage events/s regardless of call
 * volume — O(frames) not O(calls).
 *
 * Guard rails
 *   MAX_BATCH_SIZE (500) — if the queue fills before rAF fires (e.g. a
 *     synchronous burst during page load) we flush eagerly to prevent unbounded
 *     memory growth.
 *   isCapturing flag — postMessage cost is zero while paused/idle.
 *
 * ── Data flow ────────────────────────────────────────────────────────────────
 *   Prototype intercept → commandQueue[] → rAF drain → postMessage(batch)
 *   → content/index.ts → Port.postMessage → background/index.ts → CircularBuffer
 */

import {
  PAGE_MESSAGE_SENTINEL,
  type PageCommandBatchMessage,
} from '../types/messages';
import type { CanvasCommand, CommandIndex, SerializedRef } from '../types/canvas-commands';

// ─── Capture Flag ────────────────────────────────────────────────────────────

/**
 * Capture is ON by default so commands are recorded from the very first
 * canvas call (before DevTools even opens). The panel can send PAUSE_RECORDING
 * via the background → content → inject custom event to flip this flag.
 */
let isCapturing = true;

// Expose a tiny control surface that the content script can reach via a
// CustomEvent dispatched on the window (the only safe cross-world channel
// besides postMessage). The content script fires:
//   window.dispatchEvent(new CustomEvent('__canvasLint:control', { detail: { cmd: 'pause' } }))
window.addEventListener('__canvasLint:control', (e: Event) => {
  const detail = (e as CustomEvent<{ cmd: string }>).detail;
  if (detail?.cmd === 'pause')  isCapturing = false;
  if (detail?.cmd === 'resume') isCapturing = true;
  if (detail?.cmd === 'reset') {
    isCapturing = true;
    logicalCommandIndex = 0;
  }
});

// ─── Identity Tracking ───────────────────────────────────────────────────────

let nextCanvasId = 0;
const canvasIds = new WeakMap<HTMLCanvasElement, number>();

function getCanvasId(canvas: HTMLCanvasElement): number {
  let id = canvasIds.get(canvas);
  if (id === undefined) {
    id = nextCanvasId++;
    canvasIds.set(canvas, id);
  }
  return id;
}

let logicalCommandIndex: CommandIndex = 0;
function nextIndex(): CommandIndex {
  return logicalCommandIndex++;
}

// ─── Serialized References ───────────────────────────────────────────────────

const refRegistry = new WeakMap<object, string>();

function getSerializedRef(obj: object): SerializedRef {
  let refId = refRegistry.get(obj);
  if (!refId) {
    refId = crypto.randomUUID();
    refRegistry.set(obj, refId);
  }

  const originalType = Object.prototype.toString.call(obj).slice(8, -1);

  // Capture asset URL for replay: if the replay engine can load this URL
  // it can reconstruct an HTMLImageElement and execute the draw correctly.
  let data: string | undefined;
  if (obj instanceof HTMLImageElement && obj.src) {
    data = obj.src;
  } else if (obj instanceof HTMLVideoElement && obj.currentSrc) {
    data = obj.currentSrc;
  }

  return { __type: 'SerializedRef', refId, originalType, data };
}

/** Primitive pass-through; objects become opaque SerializedRef tokens. */
function serializeArgs(args: any[]): any[] {
  return args.map((arg) => {
    if (arg === null || arg === undefined) return arg;
    if (typeof arg === 'object' || typeof arg === 'function') return getSerializedRef(arg);
    return arg;
  });
}

// ─── Micro-queue & rAF batching ──────────────────────────────────────────────

/**
 * Maximum commands buffered before forcing an eager flush.
 * Protects against synchronous bursts (e.g. procedural map generation) that
 * could fill memory before the next rAF callback fires.
 */
const MAX_BATCH_SIZE = 500;

let commandQueue: CanvasCommand[] = [];
let rafPending = false;

/** Flush the accumulated queue in a single postMessage. */
function flushQueue(): void {
  rafPending = false;
  if (commandQueue.length === 0) return;

  const batch = commandQueue;
  commandQueue = [];

  const msg: PageCommandBatchMessage = {
    [PAGE_MESSAGE_SENTINEL]: true,
    type: 'CANVAS_COMMAND_BATCH',
    payload: batch,
  };

  // targetOrigin '*' is safe here: the content script validates the sentinel
  // and ONLY the isolated-world listener receives it — the host page cannot
  // intercept its own messages in a meaningful way because it already has full
  // DOM access. The data crossing this boundary contains no secrets.
  window.postMessage(msg, '*');
}

/** Enqueue a command; schedule a rAF drain if one isn't already pending. */
function enqueue(command: CanvasCommand): void {
  if (!isCapturing) return;

  commandQueue.push(command);

  // Eager flush on burst to prevent unbounded memory growth
  if (commandQueue.length >= MAX_BATCH_SIZE) {
    flushQueue();
    return;
  }

  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(flushQueue);
  }
}

// ─── Command Builder ─────────────────────────────────────────────────────────

/** Stamps timestamp, index, canvasId onto a partial payload and enqueues it. */
function emitCommand(
  basePayload: Omit<CanvasCommand, 'timestamp' | 'index' | 'canvasId'>,
  canvas: HTMLCanvasElement
): void {
  const command = {
    ...basePayload,
    timestamp: performance.now(),
    index:     nextIndex(),
    canvasId:  getCanvasId(canvas),
  } as CanvasCommand;

  enqueue(command);
}

// ─── Generic Method Interception ─────────────────────────────────────────────

// save/restore are intentionally excluded — they get explicit handlers below
// that also track the save-depth counter for the parser.
const METHODS = [
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo',
  'arc', 'arcTo', 'ellipse', 'rect', 'fill', 'stroke', 'fillRect', 'strokeRect',
  'clearRect', 'fillText', 'strokeText', 'putImageData',
  'clip', 'translate', 'rotate', 'scale', 'transform', 'setTransform',
  'resetTransform', 'setLineDash',
] as const;

for (const method of METHODS) {
  const original = (CanvasRenderingContext2D.prototype as any)[method];
  if (typeof original !== 'function') continue;

  (CanvasRenderingContext2D.prototype as any)[method] = function (
    this: CanvasRenderingContext2D,
    ...args: any[]
  ) {
    // ❗ Execute original FIRST — always — even if capture is off.
    //    We never sacrifice correctness of the host page.
    const result = original.apply(this, args);
    emitCommand(
      { method, args: serializeArgs(args) } as Omit<CanvasCommand, 'timestamp' | 'index' | 'canvasId'>,
      this.canvas,
    );
    return result;
  };
}

// ─── drawImage (three arity overloads) ───────────────────────────────────────

const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (
  this: CanvasRenderingContext2D,
  ...args: any[]
) {
  const result = originalDrawImage.apply(this, args as any);

  let variant: 'drawImage:3' | 'drawImage:5' | 'drawImage:9' = 'drawImage:3';
  if (args.length >= 9) variant = 'drawImage:9';
  else if (args.length >= 5) variant = 'drawImage:5';

  emitCommand({ method: variant, args: serializeArgs(args) } as any, this.canvas);
  return result;
};

// ─── save / restore — explicit with save-depth tracking ──────────────────────

/**
 * Per-context save-depth counter.
 * save() pushes, restore() pops. If restore() is called at depth 0 the
 * context silently no-ops; we log the same phantom restore so the panel can
 * detect "stack drift" and emit a ReplayWarning (PRD §5).
 */
const saveDepths = new WeakMap<CanvasRenderingContext2D, number>();

function getSaveDepth(ctx: CanvasRenderingContext2D): number {
  return saveDepths.get(ctx) ?? 0;
}

const originalSave = CanvasRenderingContext2D.prototype.save;
CanvasRenderingContext2D.prototype.save = function (this: CanvasRenderingContext2D) {
  originalSave.call(this);
  saveDepths.set(this, getSaveDepth(this) + 1);
  emitCommand({ method: 'save', args: [], saveDepthAfter: getSaveDepth(this) } as any, this.canvas);
};

const originalRestore = CanvasRenderingContext2D.prototype.restore;
CanvasRenderingContext2D.prototype.restore = function (this: CanvasRenderingContext2D) {
  const depthBefore = getSaveDepth(this);

  originalRestore.call(this);

  // Track the new depth (min 0 — native context enforces the floor)
  const depthAfter = Math.max(0, depthBefore - 1);
  saveDepths.set(this, depthAfter);

  emitCommand({
    method: 'restore',
    args: [],
    saveDepthAfter: depthAfter,
    // Flag stack drift so the background parser can emit a warning
    stackDrift: depthBefore === 0,
  } as any, this.canvas);
};

// ─── Property Setters ────────────────────────────────────────────────────────

const SETTER_PROPS = [
  'fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'lineCap', 'lineJoin',
  'miterLimit', 'lineDashOffset', 'shadowColor', 'shadowBlur', 'shadowOffsetX',
  'shadowOffsetY', 'font', 'textAlign', 'textBaseline', 'globalCompositeOperation',
  'imageSmoothingEnabled', 'imageSmoothingQuality',
] as const;

for (const prop of SETTER_PROPS) {
  const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, prop);
  if (!descriptor?.set) continue;

  const originalSet = descriptor.set;

  Object.defineProperty(CanvasRenderingContext2D.prototype, prop, {
    set(this: CanvasRenderingContext2D, val: any) {
      originalSet.call(this, val);
      const serializedVal = (typeof val === 'object' && val !== null)
        ? getSerializedRef(val)
        : val;
      emitCommand(
        { method: `set:${prop}`, value: serializedVal } as Omit<CanvasCommand, 'timestamp' | 'index' | 'canvasId'>,
        this.canvas,
      );
    },
    get: descriptor.get,
    enumerable:   descriptor.enumerable,
    configurable: descriptor.configurable,
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

console.debug('[CanvasLint:Inject] CanvasRenderingContext2D proxy active — rAF batching enabled.');
