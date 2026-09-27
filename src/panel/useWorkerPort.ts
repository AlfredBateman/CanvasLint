/**
 * useWorkerPort.ts
 *
 * React hook that owns the lifetime of the chrome.runtime.Port connecting the
 * DevTools panel to the background service worker ('devtools' port, Channel C).
 *
 * ── Responsibilities ─────────────────────────────────────────────────────────
 * 1. Open the port when the panel mounts, announce with DEVTOOLS_INIT.
 * 2. Dispatch every incoming WorkerToPanelMessage to the Zustand store.
 * 3. Reconnect automatically on disconnect (service worker idle-kill).
 * 4. Expose a stable `sendToWorker` function — the only way components should
 *    write to the background (start/pause/reset, command slice requests).
 *
 * ── Why this is a hook, not a module-level singleton ─────────────────────────
 * The DevTools panel page can be torn down and remounted (e.g. user closes and
 * reopens DevTools). A hook bound to a React component's lifecycle correctly
 * closes the port on unmount and re-opens it on remount. A module-level port
 * would hold a stale reference after the panel page reloads.
 *
 * ── Reconnect strategy ───────────────────────────────────────────────────────
 * MV3 service workers are killed after ~30 s of inactivity. When the port
 * disconnects the hook schedules a reconnect attempt at increasing intervals
 * (250 ms → 500 → 1000 → … capped at 8 s). On reconnect it sends DEVTOOLS_INIT
 * again so the background resends a full WORKER_SNAPSHOT.
 */

import { useEffect, useRef, useCallback } from 'react';
import type React from 'react';
import { usePanelStore } from './usePanelStore';
import { createBackoff, type Backoff } from '../types/backoff';
import type {
  PanelToWorkerMessage,
  WorkerToPanelMessage,
  PortMessage,
} from '../types/messages';

export function useWorkerPort(): {
  sendToWorker: (msg: PanelToWorkerMessage) => void;
  portRef: React.RefObject<chrome.runtime.Port | null>;
} {
  const portRef            = useRef<chrome.runtime.Port | null>(null);
  const backoffRef         = useRef<Backoff | null>(null);
  const isMountedRef       = useRef(true);
  if (backoffRef.current === null) backoffRef.current = createBackoff();
  const backoff = backoffRef.current;

  const actions = usePanelStore((s) => s.actions);

  // ── Message dispatcher ────────────────────────────────────────────────────

  const handleWorkerMessage = useCallback((message: PortMessage) => {
    // Narrow to messages the worker sends to the panel
    const m = message as WorkerToPanelMessage;

    switch (m.type) {
      case 'WORKER_SNAPSHOT':
        actions.setConnected(chrome.devtools.inspectedWindow.tabId);
        actions.applySnapshot(m.payload);
        break;

      case 'WORKER_BLOCKS_DELTA':
        actions.applyDelta(m.payload);
        break;

      case 'RECORDING_STATUS':
        actions.setRecordingStatus(m.payload.status);
        break;

      case 'WORKER_WARNING':
        actions.addWarning(m.payload);
        break;

      case 'COMMAND_SLICE':
        // The replay engine subscribes directly to this via the port ref.
        // We don't store raw command slices in Zustand — they're transient.
        // The replay engine (useReplayEngine.ts) will handle this message.
        break;

      default:
        // Exhaustiveness guard — log and ignore
        console.warn('[CanvasLint:Panel] Unknown worker message:', (m as any).type);
    }
  }, [actions]);

  // ── Port lifecycle ────────────────────────────────────────────────────────

  const openPort = useCallback(() => {
    if (!isMountedRef.current) return;

    try {
      const port = chrome.runtime.connect({ name: 'devtools' });
      portRef.current = port;
      backoff.reset(); // reset back-off on success

      port.onMessage.addListener(handleWorkerMessage);

      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; // Suppress unchecked lastError warnings
        portRef.current = null;
        actions.setDisconnected();

        if (isMountedRef.current) {
          backoff.scheduleReconnect(openPort);
        }
      });

      // Announce which tab we're inspecting
      port.postMessage({
        type:    'DEVTOOLS_INIT',
        payload: { tabId: chrome.devtools.inspectedWindow.tabId },
      } satisfies PanelToWorkerMessage);

      console.debug('[CanvasLint:Panel] Port opened, DEVTOOLS_INIT sent.');
    } catch (err) {
      actions.setConnError(`Failed to open port: ${(err as Error).message}`);
      backoff.scheduleReconnect(openPort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleWorkerMessage, actions]);

  useEffect(() => {
    isMountedRef.current = true;
    openPort();

    return () => {
      isMountedRef.current = false;
      backoff.cancel();
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [openPort, backoff]);

  // ── Stable send helper ────────────────────────────────────────────────────

  /**
   * Sends a message to the background worker.
   * Safe to call even if the port is temporarily disconnected — the message
   * is silently dropped and the reconnect will trigger a REQUEST_SNAPSHOT.
   */
  const sendToWorker = useCallback((msg: PanelToWorkerMessage) => {
    if (!portRef.current) {
      console.warn('[CanvasLint:Panel] sendToWorker called while disconnected:', msg.type);
      return;
    }
    try {
      portRef.current.postMessage(msg);
    } catch (err) {
      console.warn('[CanvasLint:Panel] postMessage failed:', err);
      portRef.current = null;
      actions.setDisconnected();
      backoff.scheduleReconnect(openPort);
    }
  }, [actions, openPort, backoff]);

  return { sendToWorker, portRef };
}
