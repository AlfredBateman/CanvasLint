/**
 * CanvasLint Background Service Worker
 *
 * Owns two long-lived Port families:
 *
 *   'content-relay'  — one per tab, receives RELAY_COMMAND_BATCH from the
 *                      content script and writes each command into the
 *                      circular buffer.
 *
 *   'devtools'       — one per open DevTools panel, receives control messages
 *                      (DEVTOOLS_INIT, START_RECORDING, HARD_RESET, …) and
 *                      pushes WORKER_BLOCKS_DELTA + RECORDING_STATUS back.
 *
 * ── Panel delta flush strategy ───────────────────────────────────────────────
 * Flushing on every batch would produce up to 60 Port messages/s to the panel
 * React app — causing layout thrashing.  Instead we accumulate newly-committed
 * blocks in `pendingDeltaBlocks` and drain them on a 250 ms interval (~4 Hz).
 * This is the same pattern used by Chrome DevTools' own network panel.
 *
 * ── Buffer management ────────────────────────────────────────────────────────
 * The 10 000-command circular buffer is shared across all tabs for simplicity.
 * A future version could shard by tabId.
 */

import {
  CONTENT_RELAY_PORT_NAME,
  type ContentToWorkerMessage,
  type PortMessage,
  isPanelToWorkerMessage,
  type WorkerBlocksDeltaMessage,
  type RecordingStatusMessage,
  type WorkerSnapshotMessage,
} from '../types/messages';
import {
  createCircularBuffer,
  pushToBuffer,
  drainBuffer,
  resetBuffer,
  type CircularBuffer,
} from '../types/circular-buffer';
import type { CanvasCommand } from '../types/canvas-commands';
import type { RenderBlock } from '../types/render-blocks';
import type { RecordingStatus } from '../types/app-state';

// ─── Global state ────────────────────────────────────────────────────────────

let commandBuffer: CircularBuffer<CanvasCommand> = createCircularBuffer();
let recordingStatus: RecordingStatus = 'recording';

// Render blocks produced by the parser (stub — parser built in next phase)
let allRenderBlocks: RenderBlock[] = [];

// Blocks committed since the last delta flush — sent to panel on next tick
let pendingDeltaBlocks: RenderBlock[] = [];

// ─── Panel port registry ─────────────────────────────────────────────────────

/** tabId → DevTools panel Port */
const devtoolsPorts = new Map<number, chrome.runtime.Port>();

function broadcastToAllPanels(msg: PortMessage): void {
  for (const port of devtoolsPorts.values()) {
    try { port.postMessage(msg); } catch { /* port may be stale */ }
  }
}

// ─── Delta flush to panel (~4 Hz) ────────────────────────────────────────────

const DELTA_FLUSH_INTERVAL_MS = 250;

setInterval(() => {
  if (pendingDeltaBlocks.length === 0) return;

  const delta: WorkerBlocksDeltaMessage = {
    type: 'WORKER_BLOCKS_DELTA',
    payload: {
      newBlocks:        pendingDeltaBlocks.splice(0), // drain + clear
      commandCount:     commandBuffer.length,
      bufferHasWrapped: commandBuffer.hasWrapped,
    },
  };

  broadcastToAllPanels(delta);
}, DELTA_FLUSH_INTERVAL_MS);

// ─── Channel B: content-relay Port ───────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {

  // ── Channel B: content script relay ─────────────────────────────────────
  if (port.name === CONTENT_RELAY_PORT_NAME) {
    port.onMessage.addListener((message: ContentToWorkerMessage) => {
      if (recordingStatus !== 'recording') return;

      let commands: CanvasCommand[] = [];

      if (message.type === 'RELAY_COMMAND_BATCH') {
        commands = message.payload;
      } else if (message.type === 'RELAY_COMMAND') {
        // Legacy single-command path (kept for hot-reload safety during dev)
        commands = [message.payload];
      } else if (message.type === 'PAGE_NAVIGATED') {
        // Page reload — reset the buffer so old commands don't pollute new page
        handleHardReset(port.sender?.tab?.id ?? null);
        return;
      }

      // Push every command in the batch into the ring buffer (O(n) but n≤500)
      for (const cmd of commands) {
        commandBuffer = pushToBuffer(commandBuffer, cmd);
        // TODO (Phase 4): feed cmd into BlockParser → accumulate pendingDeltaBlocks
      }

      // Notify content script if buffer wrap occurred so it can surface a warning
      if (commandBuffer.hasWrapped) {
        try {
          port.postMessage({ type: 'BUFFER_WRAPPED' });
        } catch { /* port might be gone */ }
      }
    });

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      // Content port disconnected (tab closed / navigation). No cleanup needed
      // since we don't track content ports by tabId (a new one will open on next page).
      console.debug('[CanvasLint:Worker] Content relay port disconnected.');
    });

    return; // handled
  }

  // ── Channel C: DevTools panel ────────────────────────────────────────────
  if (port.name === 'devtools') {
    let panelTabId: number | null = null;

    port.onMessage.addListener((message: PortMessage) => {
      // REQUEST_COMMAND_SLICE is a standalone message type, not part of PanelToWorkerMessage union
      if ((message as any).type === 'REQUEST_COMMAND_SLICE') {
        const { startLogical, endLogical } = (message as any).payload as { startLogical: number; endLogical: number };
        const allCommands = drainBuffer(commandBuffer);
        const commands: CanvasCommand[] = [];
        for (let i = startLogical; i <= endLogical; i++) {
          const cmd = allCommands[i];
          if (cmd) commands.push(cmd);
        }
        try {
          port.postMessage({
            type: 'COMMAND_SLICE',
            payload: { commands, startLogical, endLogical },
          });
        } catch { /* stale port */ }
        return;
      }

      if (!isPanelToWorkerMessage(message)) return;

      switch (message.type) {

        case 'DEVTOOLS_INIT': {
          panelTabId = message.payload.tabId;
          devtoolsPorts.set(panelTabId, port);
          console.debug(`[CanvasLint:Worker] Panel connected for tab ${panelTabId}`);

          // Send full snapshot so the panel can hydrate immediately
          const snapshot: WorkerSnapshotMessage = {
            type: 'WORKER_SNAPSHOT',
            payload: {
              renderBlocks:     allRenderBlocks,
              commandCount:     commandBuffer.length,
              bufferHasWrapped: commandBuffer.hasWrapped,
              recordingStatus,
            },
          };
          try { port.postMessage(snapshot); } catch { /* race on first connect */ }
          break;
        }

        case 'REQUEST_SNAPSHOT': {
          const snapshot: WorkerSnapshotMessage = {
            type: 'WORKER_SNAPSHOT',
            payload: {
              renderBlocks:     allRenderBlocks,
              commandCount:     commandBuffer.length,
              bufferHasWrapped: commandBuffer.hasWrapped,
              recordingStatus,
            },
          };
          try { port.postMessage(snapshot); } catch { /* stale port */ }
          break;
        }

        case 'START_RECORDING':
          recordingStatus = 'recording';
          broadcastRecordingStatus();
          broadcastControlToContent('resume');
          break;

        case 'PAUSE_RECORDING':
          recordingStatus = 'paused';
          broadcastRecordingStatus();
          broadcastControlToContent('pause');
          break;

        case 'HARD_RESET':
          handleHardReset(panelTabId);
          break;

        default:
          console.warn('[CanvasLint:Worker] Unhandled panel message:', (message as any).type);
      }
    });

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (panelTabId !== null) {
        devtoolsPorts.delete(panelTabId);
        console.debug(`[CanvasLint:Worker] Panel disconnected for tab ${panelTabId}`);
      }
    });
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function handleHardReset(tabId: number | null): void {
  commandBuffer   = resetBuffer(commandBuffer);
  allRenderBlocks = [];
  pendingDeltaBlocks = [];
  recordingStatus = 'recording';

  console.debug(`[CanvasLint:Worker] Hard reset (tab ${tabId})`);

  // Notify panel
  const snapshot: WorkerSnapshotMessage = {
    type: 'WORKER_SNAPSHOT',
    payload: {
      renderBlocks:     [],
      commandCount:     0,
      bufferHasWrapped: false,
      recordingStatus,
    },
  };
  broadcastToAllPanels(snapshot);
  broadcastControlToContent('reset');
}

function broadcastRecordingStatus(): void {
  const msg: RecordingStatusMessage = {
    type: 'RECORDING_STATUS',
    payload: { status: recordingStatus },
  };
  broadcastToAllPanels(msg);
}

/**
 * Sends a control command to all content-relay ports.
 * We cannot directly reach them by tabId without tracking, so we use
 * chrome.tabs.sendMessage which reaches the isolated-world content script.
 * The content script then dispatches a CustomEvent into the MAIN world.
 */
function broadcastControlToContent(status: 'pause' | 'resume' | 'reset'): void {
  // Map control word back to RecordingStatus-compatible string for the content script
  const recordingMsg = status === 'resume' ? 'recording' : status === 'pause' ? 'paused' : 'idle';
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'RECORDING_STATUS', payload: { status: recordingMsg } }, () => {
        // Explicitly reading lastError suppresses the unchecked warning if the tab is cached/dead
        void chrome.runtime.lastError;
      });
    }
  });
}
