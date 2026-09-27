/**
 * app-state.ts
 *
 * Shared status/warning types used across the worker, panel store, and
 * message protocol. The panel's own state lives in the Zustand store
 * (usePanelStore.ts); this file no longer defines a parallel reducer model.
 */

import type { CommandIndex } from './canvas-commands';

export type RecordingStatus =
  | 'idle'        // Extension loaded, not yet recording
  | 'recording'   // Actively intercepting Canvas calls
  | 'paused'      // Temporarily paused; buffer retained
  | 'error';      // Injection or connection failure

export type ConnectionStatus =
  | 'connecting'   // Port opened, DEVTOOLS_INIT sent, awaiting ACK
  | 'connected'    // Background ACK received; live
  | 'disconnected' // Port closed (tab navigated, extension reloaded, etc.)
  | 'error';       // Unrecoverable protocol error

/**
 * Warnings surfaced to the user in the panel without blocking interaction.
 */
export interface ReplayWarning {
  readonly kind:
    | 'unresolved-ref'    // A SerializedRef could not be resolved (GC'd or cross-origin)
    | 'state-stack-drift' // Unbalanced save/restore detected
    | 'buffer-full'       // Circular buffer wrapped; oldest commands dropped
    | 'async-asset';      // drawImage/font asset not yet cached
  readonly message: string;
  /** CommandIndex of the command that triggered the warning. */
  readonly atIndex: CommandIndex;
}
