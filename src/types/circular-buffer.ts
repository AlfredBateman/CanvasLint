/**
 * circular-buffer.ts
 *
 * Type definitions for the 10,000-command circular buffer mandated by §3.
 *
 * From the PRD (§3 — Buffer Limit):
 *   "The system will buffer a maximum of 10,000 draw calls. A circular buffer
 *    will drop the oldest commands once this limit is reached."
 *
 * From the PRD (§4 — Computation vs. Memory):
 *   "Re-executing commands trades higher CPU usage during timeline scrubbing
 *    for a drastically smaller memory footprint."
 *
 * Implementation contract (enforced by the BackgroundWorker):
 *   - `items` is a fixed-length array allocated once at capacity.
 *   - `head` is the next write slot (mod capacity).
 *   - `length` counts live items (≤ capacity).
 *   - Once full, writing to `head` overwrites the oldest item; `length` stays
 *     at capacity; `totalCommandsEver` continues to grow.
 *   - Logical index `i` (0 = oldest live item) maps to physical index:
 *       physicalIndex = (head - length + i + capacity) % capacity
 *
 * This type is deliberately read-only from the consumer's perspective.
 * Mutations are performed only inside the BackgroundWorker through the
 * helper functions defined at the bottom of this file.
 */

import type { CanvasCommand, CommandIndex } from './canvas-commands';

// ─── Capacity constant ─────────────────────────────────────────────────────

/** Maximum number of commands stored simultaneously. From PRD §3. */
export const BUFFER_CAPACITY = 10_000 as const;

// ─── Buffer shape ──────────────────────────────────────────────────────────

/**
 * The circular buffer structure managed by the BackgroundWorker.
 *
 * `T` is parameterised so the buffer type can be used in unit tests with
 * arbitrary payloads before the full command union is available.
 */
export interface CircularBuffer<T = CanvasCommand> {
  /** Fixed maximum capacity. Always === BUFFER_CAPACITY in production. */
  readonly capacity: number;

  /**
   * Physical storage array. Pre-allocated at `capacity` length.
   * Slots not yet written contain `undefined` (cast out before reading).
   */
  readonly items: (T | undefined)[];

  /**
   * Next write slot (physical index). Range: [0, capacity).
   * After a write, advances as: head = (head + 1) % capacity.
   */
  readonly head: number;

  /**
   * Number of valid (non-undefined) items currently stored.
   * Grows from 0 to `capacity`, then stays at `capacity`.
   */
  readonly length: number;

  /**
   * Monotonically increasing count of every command ever pushed into this
   * buffer, including those that have been overwritten.
   * Used to assign a globally unique `CommandIndex` to each incoming command.
   */
  readonly totalCommandsEver: CommandIndex;

  /**
   * True once the buffer has wrapped at least once (length === capacity after
   * an additional write). The UI should display a "buffer full — oldest
   * commands dropped" badge when this is true.
   */
  readonly hasWrapped: boolean;
}

/** Creates an empty, pre-allocated circular buffer. */
export function createCircularBuffer(
  capacity: number = BUFFER_CAPACITY,
): CircularBuffer {
  return {
    capacity,
    items:             new Array(capacity).fill(undefined),
    head:              0,
    length:            0,
    totalCommandsEver: 0,
    hasWrapped:        false,
  };
}

/**
 * Returns a new CircularBuffer with `item` pushed in.
 * Pure (does not mutate the original) so it fits a Redux-style reducer.
 *
 * Time: O(1) — overwrites one slot, no shifting.
 */
export function pushToBuffer<T>(
  buffer: CircularBuffer<T>,
  item: T,
): CircularBuffer<T> {
  const items = buffer.items.slice(); // shallow copy — safe for command objects
  items[buffer.head] = item;

  const nextHead   = (buffer.head + 1) % buffer.capacity;
  const nextLength = Math.min(buffer.length + 1, buffer.capacity);
  const hasWrapped = buffer.hasWrapped || buffer.length + 1 > buffer.capacity;

  return {
    ...buffer,
    items,
    head:              nextHead,
    length:            nextLength,
    totalCommandsEver: buffer.totalCommandsEver + 1,
    hasWrapped,
  };
}

/**
 * Reads item at *logical* index `i` (0 = oldest, length-1 = newest).
 * Returns `undefined` for out-of-range indices.
 *
 * Time: O(1).
 */
export function getFromBuffer<T>(
  buffer: CircularBuffer<T>,
  logicalIndex: number,
): T | undefined {
  if (logicalIndex < 0 || logicalIndex >= buffer.length) return undefined;
  const physicalIndex =
    (buffer.head - buffer.length + logicalIndex + buffer.capacity) % buffer.capacity;
  return buffer.items[physicalIndex];
}

/**
 * Returns a new array of all live items in logical order (oldest → newest).
 * This is an O(n) operation — call only for replay initiation, not on every frame.
 */
export function drainBuffer<T>(buffer: CircularBuffer<T>): T[] {
  const result: T[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const item = getFromBuffer(buffer, i);
    if (item !== undefined) result.push(item);
  }
  return result;
}

/** Returns an empty buffer with the same capacity. Used by Hard Reset. */
export function resetBuffer<T>(buffer: CircularBuffer<T>): CircularBuffer<T> {
  return createCircularBuffer(buffer.capacity) as CircularBuffer<T>;
}
