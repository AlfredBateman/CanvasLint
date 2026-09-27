/**
 * Shared exponential back-off used by both the content-script relay port and
 * the panel's worker port: 250 ms, doubling, capped at 8 s. Extracted so both
 * reconnect loops derive from one implementation instead of two hand-written
 * copies of the same formula.
 */

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 8_000;

export interface Backoff {
  /** Schedules `dial` after the current delay, then doubles it (capped). No-op if already scheduled. */
  scheduleReconnect(dial: () => void): void;
  /** Resets the delay to its initial value. Call on a successful connection. */
  reset(): void;
  /** Cancels a pending reconnect, if any. */
  cancel(): void;
}

export function createBackoff(): Backoff {
  let delay = INITIAL_RECONNECT_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    scheduleReconnect(dial) {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        dial();
      }, delay);
    },
    reset() {
      delay = INITIAL_RECONNECT_DELAY_MS;
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
