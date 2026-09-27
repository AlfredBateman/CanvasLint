/**
 * useReplayEngine.ts
 *
 * React hook that connects the Zustand timelineCursor to the replay engine.
 *
 * ── Data flow ────────────────────────────────────────────────────────────────
 *
 *   User drags slider
 *     → store.timelineCursor = N
 *     → Zustand subscription fires (outside React render cycle)
 *     → sendReplayRequest(N) sends REQUEST_COMMAND_SLICE to background
 *     → background replies with COMMAND_SLICE { commands, startLogical, endLogical }
 *     → onSliceReceived(commands)
 *     → replayCommands(ctx, commands, N) executes on the replay canvas
 *     → store.setIsReplaying(false) unlocks the slider
 *
 * ── Why we don't store commands in Zustand ───────────────────────────────────
 * Raw command arrays are large (up to 10,000 × ~200 bytes ≈ 2 MB) and
 * transient — we only need them for the duration of one replay execution.
 * Putting them in Zustand would cause a massive React re-render tree and
 * defeat the purpose of the batching architecture. Instead, they flow through
 * a local ref and are discarded after the replay completes.
 *
 * ── Canvas sizing ─────────────────────────────────────────────────────────────
 * The replay canvas is sized to match the inspected page's canvas via a
 * ResizeObserver on the container div. When no command has been replayed yet,
 * we use a default 300×150 (HTML spec default for <canvas>).
 *
 * ── Replay guard ─────────────────────────────────────────────────────────────
 * isReplaying is set to true in the store before the slice request fires.
 * The TimelineSlider is disabled while isReplaying, preventing the user from
 * queuing another replay before the previous one completes.
 * isReplaying is always cleared in a finally block.
 */

import { useEffect, useRef, useCallback, RefObject } from 'react';
import { usePanelStore, selectActions, selectTimelineCursor } from './usePanelStore';
import { replayCommands, clearImageCache } from './replayEngine';
import type { CanvasCommand, CommandIndex } from '../types/canvas-commands';
import type { CommandSliceResponseMessage } from '../types/messages';

export function useReplayEngine(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  portRef:   RefObject<chrome.runtime.Port | null>,
): void {
  const actions = usePanelStore(selectActions);

  // Local command cache — avoids hitting the background on every cursor nudge
  // if the user is stepping through an already-fetched range.
  const commandCacheRef = useRef<CanvasCommand[]>([]);

  // Pending slice resolve function — set when a slice request is in flight.
  const pendingResolveRef = useRef<((cmds: CanvasCommand[]) => void) | null>(null);

  // ── Slice request / response ────────────────────────────────────────────────

  /**
   * Sends REQUEST_COMMAND_SLICE and returns a Promise that resolves with the
   * command array when the COMMAND_SLICE response arrives.
   * Times out after 3 seconds to prevent the isReplaying lock from hanging.
   */
  const requestSlice = useCallback((endLogical: number): Promise<CanvasCommand[]> => {
    return new Promise((resolve, reject) => {
      const port = portRef.current;
      if (!port) { reject(new Error('Port not connected')); return; }

      // Register the one-shot resolve callback
      pendingResolveRef.current = resolve;

      // Timeout guard
      const timer = setTimeout(() => {
        pendingResolveRef.current = null;
        reject(new Error('Command slice request timed out'));
      }, 3_000);

      // We need the resolve to also clear the timer
      pendingResolveRef.current = (cmds) => {
        clearTimeout(timer);
        resolve(cmds);
      };

      try {
        port.postMessage({
          type:    'REQUEST_COMMAND_SLICE',
          payload: { startLogical: 0, endLogical },
        });
      } catch (err) {
        pendingResolveRef.current = null;
        clearTimeout(timer);
        reject(err);
      }
    });
  }, [portRef]);

  // ── Port message listener for COMMAND_SLICE ─────────────────────────────────

  useEffect(() => {
    // Attach a listener to the port ref. The port may be reconnected later —
    // we re-attach via a polling interval on portRef since we cannot hook into
    // useWorkerPort's internal connect event from outside the hook.
    let attachedPort: chrome.runtime.Port | null = null;

    function onSliceMessage(msg: { type: string; payload?: unknown }) {
      if (msg.type !== 'COMMAND_SLICE') return;
      const sliceMsg = msg as CommandSliceResponseMessage;
      const commands = sliceMsg.payload.commands;
      commandCacheRef.current = commands;

      // Resolve the pending request
      if (pendingResolveRef.current) {
        const resolve = pendingResolveRef.current;
        pendingResolveRef.current = null;
        resolve(commands);
      }
    }

    // Poll every 250ms until the port appears (it opens asynchronously)
    const pollTimer = setInterval(() => {
      const port = portRef.current;
      if (port && port !== attachedPort) {
        if (attachedPort) {
          try { attachedPort.onMessage.removeListener(onSliceMessage); } catch { /* stale */ }
        }
        port.onMessage.addListener(onSliceMessage);
        attachedPort = port;
      }
    }, 250);

    return () => {
      clearInterval(pollTimer);
      if (attachedPort) {
        try { attachedPort.onMessage.removeListener(onSliceMessage); } catch { /* stale */ }
      }
    };
  }, [portRef]);

  // ── Cursor subscription + replay trigger ────────────────────────────────────

  useEffect(() => {
    // Subscribe to timelineCursor changes outside the React render cycle.
    // Zustand's `subscribeWithSelector` fires synchronously on state change.
    const unsub = usePanelStore.subscribe(
      selectTimelineCursor,
      async (cursor: CommandIndex | null) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // null cursor = live mode — clear the replay canvas
        if (cursor === null) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          return;
        }

        actions.setIsReplaying(true);

        try {
          // Try the local cache first (user is stepping through a range we already have)
          let commands = commandCacheRef.current;
          if (commands.length === 0 || cursor >= commands.length) {
            commands = await requestSlice(cursor);
          }

          // Re-check cursor hasn't moved while we were waiting for the slice
          const currentCursor = usePanelStore.getState().timelineCursor;
          if (currentCursor !== cursor) return; // stale — a newer replay is queued

          const result = replayCommands(ctx, commands, cursor);

          // Surface issues to the store
          for (const issue of result.issues) {
            actions.addWarning({
              kind:      issue.kind === 'async-asset'   ? 'async-asset'
                       : issue.kind === 'state-stack-drift' ? 'state-stack-drift'
                       : 'unresolved-ref',
              message:   issue.message,
              atIndex:   issue.atIndex,
            });
          }

          if (result.durationMs > 100) {
            console.warn(`[CanvasLint:Replay] Slow replay: ${result.durationMs.toFixed(1)}ms for ${result.executed} commands`);
          }
        } catch (err) {
          console.error('[CanvasLint:Replay] Error during replay:', err);
        } finally {
          actions.setIsReplaying(false);
        }
      },
    );

    return unsub;
  }, [canvasRef, portRef, requestSlice, actions]);

  // ── Hard reset — clear command cache and image cache ────────────────────────

  useEffect(() => {
    const unsub = usePanelStore.subscribe(
      (s) => s.renderBlocks.length,
      (len) => {
        if (len === 0) {
          // Hard reset occurred — flush caches
          commandCacheRef.current = [];
          clearImageCache();

          const canvas = canvasRef.current;
          const ctx = canvas?.getContext('2d');
          if (ctx && canvas) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
        }
      },
    );
    return unsub;
  }, [canvasRef]);
}
