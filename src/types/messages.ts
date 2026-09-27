/**
 * messages.ts
 *
 * The complete inter-context message protocol for CanvasLint.
 *
 * Three communication channels exist:
 *
 *   A. Injected page script → Content script
 *      (window.postMessage with origin check — NOT chrome.runtime)
 *      Commands are BATCHED: collected per animation frame and sent as an
 *      array in a single postMessage call. Cost: O(frames) ≈ 60/s, not O(calls).
 *
 *   B. Content script → Background worker
 *      (chrome.runtime.Port — long-lived, named 'content-relay')
 *      Switched from sendMessage (one IPC round-trip per batch) to a persistent
 *      Port so postMessage is a cheap fire-and-forget with no handshake overhead.
 *
 *   C. Background worker ↔ DevTools panel
 *      (chrome.runtime.Port — long-lived, named 'devtools')
 *      Sends render-block deltas and status updates to the panel;
 *      receives control commands (record/pause/reset) from the panel.
 *      Delta flushes are rate-limited to ~4 Hz to avoid flooding React renders.
 *
 * All messages are discriminated on `type` and fully typed.
 * No `any` types are used; `unknown` is used at trust boundaries (A).
 */

import type { CanvasCommand }     from './canvas-commands';
import type { RenderBlock }       from './render-blocks';
import type { ReplayWarning, RecordingStatus } from './app-state';

// ─── Channel A: Page script → Content script ──────────────────────────────
// Sent via window.postMessage. The content script validates the origin and
// the __canvasLint sentinel before forwarding to the background.

/** Sentinel field added to every postMessage payload for origin validation. */
export const PAGE_MESSAGE_SENTINEL = '__canvasLint' as const;

/**
 * Payload posted by the injected script to the content script.
 * Commands are BATCHED: the inject script collects all calls fired during a
 * single animation frame and sends them as one array, reducing postMessage
 * overhead from O(commands) to O(frames) ≈ 60/s max.
 */
export interface PageCommandBatchMessage {
  readonly [PAGE_MESSAGE_SENTINEL]: true;
  readonly type: 'CANVAS_COMMAND_BATCH';
  readonly payload: CanvasCommand[];
}

/** @deprecated Use PageCommandBatchMessage. Kept for type narrowing only. */
export interface PageCommandMessage {
  readonly [PAGE_MESSAGE_SENTINEL]: true;
  readonly type: 'CANVAS_COMMAND';
  readonly payload: CanvasCommand;
}

/** Type guard for incoming batched postMessage events. */
export function isPageCommandBatchMessage(data: unknown): data is PageCommandBatchMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[PAGE_MESSAGE_SENTINEL] === true &&
    (data as Record<string, unknown>)['type'] === 'CANVAS_COMMAND_BATCH'
  );
}

// ─── Channel B: Content script → Background worker ────────────────────────
// Communicated over a long-lived Port named 'content-relay' to avoid the
// per-message handshake cost of chrome.runtime.sendMessage.

/** The name used when opening the Channel B Port. */
export const CONTENT_RELAY_PORT_NAME = 'content-relay' as const;

/**
 * Relays a BATCH of captured commands from the content script to the background.
 * Replaces the old per-command RelayCommandMessage to cut IPC overhead.
 */
export interface RelayCommandBatchMessage {
  readonly type: 'RELAY_COMMAND_BATCH';
  readonly payload: CanvasCommand[];
}

/** @deprecated Use RelayCommandBatchMessage. */
export interface RelayCommandMessage {
  readonly type: 'RELAY_COMMAND';
  readonly payload: CanvasCommand;
}

/** Sent when the content script detects a page navigation (URL change). */
export interface PageNavigatedMessage {
  readonly type: 'PAGE_NAVIGATED';
  readonly payload: { tabId: number; newUrl: string };
}

export type ContentToWorkerMessage =
  | RelayCommandBatchMessage
  | RelayCommandMessage   // kept for backward-compat during migration
  | PageNavigatedMessage;

// ─── Channel C: DevTools panel → Background worker (Port messages) ─────────

/**
 * First message sent by the panel after opening the port.
 * Tells the worker which tab this panel is observing.
 */
export interface DevToolsInitMessage {
  readonly type: 'DEVTOOLS_INIT';
  readonly payload: { tabId: number };
}

/** Panel requests a full state snapshot (e.g. after reconnect). */
export interface RequestSnapshotMessage {
  readonly type: 'REQUEST_SNAPSHOT';
}

/** Panel starts or resumes recording. */
export interface StartRecordingMessage {
  readonly type: 'START_RECORDING';
}

/** Panel pauses recording (buffer retained). */
export interface PauseRecordingMessage {
  readonly type: 'PAUSE_RECORDING';
}

/** Panel executes "Hard Reset & Resync" (PRD §5). */
export interface HardResetMessage {
  readonly type: 'HARD_RESET';
  readonly payload: { tabId: number };
}

export type PanelToWorkerMessage =
  | DevToolsInitMessage
  | RequestSnapshotMessage
  | StartRecordingMessage
  | PauseRecordingMessage
  | HardResetMessage;

// ─── Channel C: Background worker → DevTools panel (Port messages) ─────────

/**
 * Full state snapshot sent in response to DEVTOOLS_INIT or REQUEST_SNAPSHOT.
 * Also sent after a HARD_RESET (with empty arrays).
 *
 * Block batching: rather than sending every command, the worker sends the
 * *parsed* RenderBlock list. The panel renders blocks in its list view and
 * requests individual command slices only when the user scrubs the timeline.
 *
 * This keeps Port traffic O(blocks) not O(commands).
 */
export interface WorkerSnapshotMessage {
  readonly type: 'WORKER_SNAPSHOT';
  readonly payload: {
    renderBlocks:     RenderBlock[];
    commandCount:     number;
    bufferHasWrapped: boolean;
    recordingStatus:  RecordingStatus;
  };
}

/**
 * Sent incrementally as new blocks are committed by the parser.
 * The panel appends these to its existing `renderBlocks` list.
 * Batched per animation frame on the worker side to avoid flooding.
 */
export interface WorkerBlocksDeltaMessage {
  readonly type: 'WORKER_BLOCKS_DELTA';
  readonly payload: {
    newBlocks:        RenderBlock[];
    commandCount:     number;
    bufferHasWrapped: boolean;
  };
}

/**
 * Sent when the panel requests a command slice for timeline replay.
 * The worker extracts commands [startIndex, endIndex] from the circular buffer
 * and sends them in order. This is the only time raw commands cross the Port.
 *
 * Note: `startIndex` and `endIndex` are *logical* indices within the buffer
 * (0 = oldest live item), not CommandIndex ordinals.
 */
export interface CommandSliceRequestMessage {
  readonly type: 'REQUEST_COMMAND_SLICE';
  readonly payload: { startLogical: number; endLogical: number };
}

export interface CommandSliceResponseMessage {
  readonly type: 'COMMAND_SLICE';
  readonly payload: {
    commands: CanvasCommand[];
    startLogical: number;
    endLogical: number;
  };
}

/**
 * A replay warning emitted by the worker and surfaced in the panel UI.
 * See ReplayWarning in app-state.ts.
 */
export interface WorkerWarningMessage {
  readonly type: 'WORKER_WARNING';
  readonly payload: ReplayWarning;
}

/** Status update following a Start/Pause/Reset action. */
export interface RecordingStatusMessage {
  readonly type: 'RECORDING_STATUS';
  readonly payload: { status: RecordingStatus };
}

export type WorkerToPanelMessage =
  | WorkerSnapshotMessage
  | WorkerBlocksDeltaMessage
  | CommandSliceResponseMessage
  | WorkerWarningMessage
  | RecordingStatusMessage;

// ─── Combined union for the Port listener ─────────────────────────────────

/**
 * Union of all Port messages that can flow in either direction.
 * The Port listener on each end should switch on `message.type`.
 */
export type PortMessage =
  | PanelToWorkerMessage
  | WorkerToPanelMessage
  | CommandSliceRequestMessage; // panel → worker, same port

// ─── Type guard helpers ────────────────────────────────────────────────────

export function isPanelToWorkerMessage(m: PortMessage): m is PanelToWorkerMessage {
  const panelTypes = new Set<string>([
    'DEVTOOLS_INIT', 'REQUEST_SNAPSHOT',
    'START_RECORDING', 'PAUSE_RECORDING', 'HARD_RESET',
    'REQUEST_COMMAND_SLICE',
  ]);
  return panelTypes.has(m.type);
}

export function isWorkerToPanelMessage(m: PortMessage): m is WorkerToPanelMessage {
  const workerTypes = new Set<string>([
    'WORKER_SNAPSHOT', 'WORKER_BLOCKS_DELTA', 'COMMAND_SLICE',
    'WORKER_WARNING', 'RECORDING_STATUS',
  ]);
  return workerTypes.has(m.type);
}
