/**
 * usePanelStore.ts
 *
 * Central Zustand store for the CanvasLint DevTools panel.
 *
 * ── Why Zustand over useReducer? ─────────────────────────────────────────────
 * The panel receives high-frequency delta updates from the background worker
 * (batched at ~4 Hz but each batch can carry many blocks). Three concerns
 * drive the choice:
 *
 *   1. Selective re-renders: Zustand's subscribeWithSelector middleware lets
 *      individual components subscribe only to the slice they need (e.g. only
 *      `commandCount` for the counter badge) without re-rendering on unrelated
 *      state changes. useReducer would re-render the entire tree on every action.
 *
 *   2. Imperative access: The Port message handler (not a React component)
 *      needs to write to state via `store.getState().actions.X()`. Zustand
 *      stores are just objects — no Provider needed, no hook-in-callback
 *      gymnastics.
 *
 *   3. Devtools integration: Zustand supports Redux DevTools out of the box via
 *      the `devtools` middleware — useful during development of a DevTools extension.
 *
 * ── State shape ──────────────────────────────────────────────────────────────
 * The store is split into three logical slices:
 *
 *   connection   — Port lifecycle and recorded tab identity
 *   capture      — Live command/block stream mirrored from the background worker
 *   ui           — User's selection, timeline cursor, replay state
 *
 * Actions are co-located with the state they mutate, using the `actions`
 * namespace convention to keep the shape flat and selector-friendly.
 *
 * ── Timeline cursor semantics ─────────────────────────────────────────────────
 * `timelineCursor` is the logical command index the user has scrubbed to.
 * null  = "show current state" (live mode — no replay active).
 * 0…N   = "replay commands 0..N onto the DevTools canvas".
 *
 * Replay is intentionally NOT triggered inside the store — the store only
 * exposes the cursor value. The replay engine in `useReplayEngine.ts` watches
 * the cursor via a Zustand selector subscription and drives the canvas.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import type { RenderBlock, ContextStateSnapshot } from '../types/render-blocks';
import type { CommandIndex }                       from '../types/canvas-commands';
import type { ConnectionStatus, RecordingStatus, ReplayWarning } from '../types/app-state';

// ─── Store shape ─────────────────────────────────────────────────────────────

export interface ConnectionSlice {
  status:          ConnectionStatus;
  inspectedTabId:  number | null;
  lastHeartbeatAt: number | null; // performance.now() of last message received
  errorMessage:    string | null;
}

export interface CaptureSlice {
  /** All render blocks received from the background, in arrival order. */
  renderBlocks:     RenderBlock[];
  /** Total number of commands currently in the background's circular buffer. */
  commandCount:     number;
  /** True once the 10,000-item circular buffer has wrapped (oldest items lost). */
  bufferHasWrapped: boolean;
  /** Whether CanvasLint is actively intercepting calls on the page. */
  recordingStatus:  RecordingStatus;
  /** Warnings accumulated since last reset (stack drift, unresolved refs, etc.). */
  warnings:         ReplayWarning[];
}

export interface UISlice {
  /**
   * The logical command index the timeline slider points to.
   * null = live mode (no replay, show latest state).
   */
  timelineCursor: CommandIndex | null;
  /** Is the replay engine currently executing? Disables the slider during replay. */
  isReplaying:    boolean;
  /** ID of the block the user last clicked in the block list. */
  selectedBlockId: number | null;
  /**
   * Context state snapshot for the selected block.
   * Populated by the port message handler when a block is selected.
   * Drives the Live State Inspector panel.
   */
  selectedBlockState: ContextStateSnapshot | null;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export interface PanelActions {
  // Connection
  setConnected:    (tabId: number) => void;
  setDisconnected: () => void;
  setConnError:    (msg: string)   => void;

  // Capture (driven by worker messages)
  applySnapshot: (payload: {
    renderBlocks:     RenderBlock[];
    commandCount:     number;
    bufferHasWrapped: boolean;
    recordingStatus:  RecordingStatus;
  }) => void;
  applyDelta: (payload: {
    newBlocks:        RenderBlock[];
    commandCount:     number;
    bufferHasWrapped: boolean;
  }) => void;
  addWarning:          (w: ReplayWarning) => void;
  setRecordingStatus:  (s: RecordingStatus) => void;

  // UI
  setTimelineCursor:   (index: CommandIndex | null) => void;
  setIsReplaying:      (b: boolean) => void;
  selectBlock:         (id: number, state: ContextStateSnapshot) => void;
  clearSelection:      () => void;

  // Hard reset — clears all capture + UI state
  hardReset: () => void;
}

// ─── Full store type ──────────────────────────────────────────────────────────

export type PanelStore = ConnectionSlice & CaptureSlice & UISlice & {
  actions: PanelActions;
};

// ─── Initial values ───────────────────────────────────────────────────────────

const INITIAL_CONNECTION: ConnectionSlice = {
  status:          'connecting',
  inspectedTabId:  null,
  lastHeartbeatAt: null,
  errorMessage:    null,
};

const INITIAL_CAPTURE: CaptureSlice = {
  renderBlocks:     [],
  commandCount:     0,
  bufferHasWrapped: false,
  recordingStatus:  'idle',
  warnings:         [],
};

const INITIAL_UI: UISlice = {
  timelineCursor:     null,
  isReplaying:        false,
  selectedBlockId:    null,
  selectedBlockState: null,
};

// ─── Store ────────────────────────────────────────────────────────────────────

export const usePanelStore = create<PanelStore>()(
  subscribeWithSelector((set, _get) => ({
    // Initial state
    ...INITIAL_CONNECTION,
    ...INITIAL_CAPTURE,
    ...INITIAL_UI,

    actions: {
      // ── Connection ────────────────────────────────────────────────────────

      setConnected: (tabId) => set({
        status:          'connected',
        inspectedTabId:  tabId,
        lastHeartbeatAt: performance.now(),
        errorMessage:    null,
      }),

      setDisconnected: () => set({
        status:          'disconnected',
        lastHeartbeatAt: null,
        // Retain inspectedTabId so the panel can show "was observing tab X"
      }),

      setConnError: (msg) => set({
        status:       'error',
        errorMessage: msg,
      }),

      // ── Capture ───────────────────────────────────────────────────────────

      /**
       * Full snapshot received on DEVTOOLS_INIT or REQUEST_SNAPSHOT.
       * Replaces the entire capture slice — used after reconnects.
       */
      applySnapshot: ({ renderBlocks, commandCount, bufferHasWrapped, recordingStatus }) =>
        set({
          renderBlocks,
          commandCount,
          bufferHasWrapped,
          recordingStatus,
          // Preserve warnings across reconnects (they are still relevant)
          lastHeartbeatAt: performance.now(),
        }),

      /**
       * Incremental delta received from the background every ~250 ms.
       * Appends new blocks without touching the rest of capture state.
       *
       * Performance note: Zustand's set() shallowly merges — only components
       * subscribed to `renderBlocks`, `commandCount`, or `bufferHasWrapped`
       * will re-render. Components watching only `timelineCursor` are unaffected.
       */
      applyDelta: ({ newBlocks, commandCount, bufferHasWrapped }) =>
        set((state) => ({
          renderBlocks:     [...state.renderBlocks, ...newBlocks],
          commandCount,
          bufferHasWrapped,
          lastHeartbeatAt:  performance.now(),
        })),

      addWarning: (w) =>
        set((state) => ({ warnings: [...state.warnings, w] })),

      setRecordingStatus: (s) => set({ recordingStatus: s }),

      // ── UI ────────────────────────────────────────────────────────────────

      /**
       * Moves the timeline slider cursor.
       * Setting to `null` returns to live mode (no replay).
       * The replay engine watches this via Zustand subscription —
       * it does NOT need to be called from inside a React component.
       */
      setTimelineCursor: (index) => set({ timelineCursor: index }),

      setIsReplaying: (b) => set({ isReplaying: b }),

      selectBlock: (id, state) => set({
        selectedBlockId:    id,
        selectedBlockState: state,
      }),

      clearSelection: () => set({
        selectedBlockId:    null,
        selectedBlockState: null,
      }),

      // ── Hard Reset ────────────────────────────────────────────────────────

      /**
       * Resets all capture and UI state to initial values.
       * Called when the user clicks "Hard Reset & Resync" (PRD §5).
       * The panel also sends a HARD_RESET Port message to the background
       * to flush the worker's circular buffer — this is handled in the
       * Port connection hook (useWorkerPort.ts), not here.
       */
      hardReset: () => set({
        ...INITIAL_CAPTURE,
        ...INITIAL_UI,
        // Keep connection state intact — the port is still live
      }),
    },
  })),
);

// ─── Typed selectors (memoisation-friendly) ───────────────────────────────────

/** Use these in components instead of inline arrow functions to keep reference stability. */

export const selectRenderBlocks      = (s: PanelStore) => s.renderBlocks;
export const selectCommandCount      = (s: PanelStore) => s.commandCount;
export const selectBufferHasWrapped  = (s: PanelStore) => s.bufferHasWrapped;
export const selectRecordingStatus   = (s: PanelStore) => s.recordingStatus;
export const selectWarnings          = (s: PanelStore) => s.warnings;
export const selectConnectionStatus  = (s: PanelStore) => s.status;
export const selectInspectedTabId    = (s: PanelStore) => s.inspectedTabId;
export const selectTimelineCursor    = (s: PanelStore) => s.timelineCursor;
export const selectIsReplaying       = (s: PanelStore) => s.isReplaying;
export const selectSelectedBlockId   = (s: PanelStore) => s.selectedBlockId;
export const selectSelectedBlockState = (s: PanelStore) => s.selectedBlockState;
export const selectActions           = (s: PanelStore) => s.actions;
