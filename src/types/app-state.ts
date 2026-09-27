/**
 * app-state.ts
 *
 * Top-level application state type for the CanvasLint DevTools panel.
 *
 * State is owned by the DevTools panel (React) and hydrated from the
 * BackgroundWorker via the message protocol defined in messages.ts.
 * It is intentionally separated from the BackgroundWorker's own internal
 * state (WorkerState below) because the two contexts have different needs:
 *
 *   BackgroundWorker  → owns the CircularBuffer and authoritative BlockParser.
 *   DevTools Panel    → owns the UI selection state, replay cursor, and
 *                       derived view-model data projected from the worker.
 *
 * File structure:
 *   1. Recording state (is the capture running?)
 *   2. Connection state (background ↔ panel port lifecycle)
 *   3. Panel UI state (timeline cursor, selected block, replay canvas)
 *   4. Worker-side state shape (the BackgroundWorker's own store)
 *   5. Full panel AppState union
 *   6. Action union for the panel's reducer
 */

import type { CanvasCommand, CommandIndex }  from './canvas-commands';
import type { RenderBlock, ContextStateSnapshot, BlockParserState } from './render-blocks';
import type { CircularBuffer }               from './circular-buffer';

// ─── 1. Recording state ────────────────────────────────────────────────────

export type RecordingStatus =
  | 'idle'        // Extension loaded, not yet recording
  | 'recording'   // Actively intercepting Canvas calls
  | 'paused'      // Temporarily paused; buffer retained
  | 'error';      // Injection or connection failure

// ─── 2. Connection state ───────────────────────────────────────────────────

export type ConnectionStatus =
  | 'connecting'   // Port opened, DEVTOOLS_INIT sent, awaiting ACK
  | 'connected'    // Background ACK received; live
  | 'disconnected' // Port closed (tab navigated, extension reloaded, etc.)
  | 'error';       // Unrecoverable protocol error

export interface ConnectionState {
  readonly status:        ConnectionStatus;
  /** chrome.devtools.inspectedWindow.tabId for the observed page. */
  readonly inspectedTabId: number | null;
  /** ISO timestamp of the last successful message round-trip. */
  readonly lastHeartbeatAt: string | null;
  /** Human-readable error description if status === 'error'. */
  readonly errorMessage: string | null;
}

// ─── 3. Panel UI state ─────────────────────────────────────────────────────

/**
 * The panel's timeline is driven by a logical step index [0, commandCount).
 * Step N means: replay commands [0…N] onto the DevTools canvas to reconstruct
 * the page's rendering at that point in history.
 *
 * This maps to the PRD timeline mechanism:
 *   "To view step N, the extension clears an isolated UI canvas and sequentially
 *    re-executes the stored array of intercepted commands from index 0 to N."
 */
export interface TimelineState {
  /**
   * The logical index of the currently selected step.
   * Null means "show the final state" (end of buffer).
   */
  readonly currentStepIndex: CommandIndex | null;

  /**
   * The total number of commands currently in the buffer (= buffer.length).
   * Drives the slider's max value.
   */
  readonly commandCount: number;

  /**
   * True while the replay engine is executing commands onto the DevTools canvas.
   * The slider is disabled during this time to prevent concurrent replays.
   */
  readonly isReplaying: boolean;
}

/**
 * Which block in the RenderBlock list is currently highlighted.
 * Null = no selection.
 */
export interface SelectionState {
  readonly selectedBlockId: number | null; // BlockId
  /**
   * The context state snapshot at the selected block.
   * Populated lazily when a block is selected; used by the Live State Inspector.
   */
  readonly selectedBlockState: ContextStateSnapshot | null;
}

/**
 * Warnings surfaced to the user in the panel without blocking interaction.
 */
export interface ReplayWarning {
  readonly kind:
    | 'unresolved-ref'    // A SerializedRef could not be resolved (GC'd or cross-origin)
    | 'state-stack-drift' // Unbalanced save/restore detected (PRD §5)
    | 'buffer-full'       // Circular buffer wrapped; oldest commands dropped
    | 'async-asset';      // drawImage/font asset not yet cached (PRD §5)
  readonly message: string;
  /** CommandIndex of the command that triggered the warning. */
  readonly atIndex: CommandIndex;
}

// ─── 4. Worker-side state ──────────────────────────────────────────────────

/**
 * Internal state shape owned exclusively by the BackgroundWorker.
 * Not exposed directly to the panel — the worker sends derived projections.
 *
 * The panel never writes to this type; it's typed here so the worker's
 * reducer can be fully typed and the protocol's response types can reference it.
 */
export interface WorkerState {
  /** The live circular command buffer. */
  readonly commandBuffer: CircularBuffer<CanvasCommand>;

  /** Parsed render blocks derived from the buffer. Rebuilt incrementally. */
  readonly renderBlocks: RenderBlock[];

  /** Internal state of the incremental block parser. */
  readonly parserState: BlockParserState;

  /** Current recording lifecycle state. */
  readonly recordingStatus: RecordingStatus;

  /**
   * Map from chrome tab id → recording status, for multi-tab awareness.
   * Only the inspected tab's status is sent to the panel.
   */
  readonly tabStatus: Record<number, RecordingStatus>;
}

// ─── 5. Panel AppState ─────────────────────────────────────────────────────

/**
 * The complete state tree of the DevTools panel React app.
 *
 * Lifecycle:
 *   1. Panel loads → AppState initialises to `initialAppState`.
 *   2. Port opens → connection status → 'connecting'.
 *   3. Background ACK → 'connected'; worker sends a full WorkerSnapshot.
 *   4. Panel applies WorkerSnapshot to populate blocks/timeline.
 *   5. User scrubs slider → currentStepIndex updates; replay engine fires.
 *   6. User selects block → selectedBlockId + selectedBlockState populate.
 *   7. "Hard Reset" → flushes all derived state, sends HARD_RESET to worker.
 */
export interface AppState {
  // ── Source of truth (mirrored from BackgroundWorker) ───────────────────
  /** Render blocks sent by the background worker. Panel renders these. */
  readonly renderBlocks: RenderBlock[];
  /** Total commands in the worker's buffer, for the timeline slider max. */
  readonly commandCount: number;
  /** Whether the buffer has wrapped (oldest commands dropped). */
  readonly bufferHasWrapped: boolean;

  // ── UI state owned by the panel ─────────────────────────────────────────
  readonly timeline:   TimelineState;
  readonly selection:  SelectionState;
  readonly connection: ConnectionState;
  readonly recording:  RecordingStatus;

  // ── Feedback ─────────────────────────────────────────────────────────────
  /** Active warnings surfaced to the user. Cleared on Hard Reset. */
  readonly warnings: ReplayWarning[];
}

/** The panel's initial state before the worker connection is established. */
export const initialAppState: AppState = {
  renderBlocks:   [],
  commandCount:   0,
  bufferHasWrapped: false,

  timeline: {
    currentStepIndex: null,
    commandCount:     0,
    isReplaying:      false,
  },

  selection: {
    selectedBlockId:    null,
    selectedBlockState: null,
  },

  connection: {
    status:           'connecting',
    inspectedTabId:   null,
    lastHeartbeatAt:  null,
    errorMessage:     null,
  },

  recording: 'idle',
  warnings:  [],
};

// ─── 6. Panel action union ─────────────────────────────────────────────────

/**
 * Discriminated union of every action that can mutate AppState.
 * Consumed by the panel's useReducer hook.
 *
 * Actions prefixed with WORKER_ originate from the BackgroundWorker
 * (received via the Port) and are converted to this union by the message handler.
 */

/** Dispatched when the background ACKs the DEVTOOLS_INIT handshake. */
export interface ConnectedAction {
  type: 'CONNECTED';
  payload: { tabId: number };
}

/** Dispatched when the port disconnects (tab reload, extension update, etc.). */
export interface DisconnectedAction {
  type: 'DISCONNECTED';
}

/** Dispatched when the worker sends a batch of new render blocks. */
export interface WorkerBlocksReceivedAction {
  type: 'WORKER_BLOCKS_RECEIVED';
  payload: {
    renderBlocks: RenderBlock[];
    commandCount: number;
    bufferHasWrapped: boolean;
  };
}

/** Dispatched when the worker sends a new warning event. */
export interface WorkerWarningAction {
  type: 'WORKER_WARNING';
  payload: ReplayWarning;
}

/** Dispatched when the user changes the recording state (start/stop/pause). */
export interface SetRecordingStatusAction {
  type: 'SET_RECORDING_STATUS';
  payload: RecordingStatus;
}

/** Dispatched when the user drags the timeline slider. */
export interface SetTimelineStepAction {
  type: 'SET_TIMELINE_STEP';
  payload: { stepIndex: CommandIndex | null };
}

/** Dispatched by the replay engine when it starts executing. */
export interface ReplayStartedAction {
  type: 'REPLAY_STARTED';
}

/** Dispatched by the replay engine when it finishes executing. */
export interface ReplayFinishedAction {
  type: 'REPLAY_FINISHED';
}

/** Dispatched when the user clicks a block in the list view. */
export interface SelectBlockAction {
  type: 'SELECT_BLOCK';
  payload: {
    blockId:       number; // BlockId
    stateSnapshot: ContextStateSnapshot;
  };
}

/** Dispatched when the user clicks "Hard Reset & Resync" (PRD §5). */
export interface HardResetAction {
  type: 'HARD_RESET';
}

/** Dispatched when a recoverable error is surfaced by the connection layer. */
export interface ConnectionErrorAction {
  type: 'CONNECTION_ERROR';
  payload: { message: string };
}

export type AppAction =
  | ConnectedAction
  | DisconnectedAction
  | WorkerBlocksReceivedAction
  | WorkerWarningAction
  | SetRecordingStatusAction
  | SetTimelineStepAction
  | ReplayStartedAction
  | ReplayFinishedAction
  | SelectBlockAction
  | HardResetAction
  | ConnectionErrorAction;
