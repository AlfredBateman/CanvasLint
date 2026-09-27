/**
 * CanvasLint Content Script — ISOLATED world
 *
 * Role (PRD §6): Pure passthrough relay between the MAIN-world inject script
 * and the background service worker.
 *
 * ── Batching contract ────────────────────────────────────────────────────────
 * The inject script sends one CANVAS_COMMAND_BATCH per animation frame (≤60/s).
 * This script forwards each batch to the background over a long-lived Port
 * ('content-relay') using port.postMessage — a cheap zero-handshake write.
 *
 * Why Port and not chrome.runtime.sendMessage?
 *   sendMessage opens a new IPC channel, waits for a response handshake, then
 *   tears it down — roughly 0.5–2 ms overhead per call. At 60 batches/s that
 *   adds 30–120 ms of pure IPC overhead per second, and the response callback
 *   holds a JS execution slot open the entire time.
 *   A Port.postMessage is fire-and-forget on an already-open pipe: effectively
 *   zero overhead beyond structured-clone of the payload.
 *
 * ── Port lifecycle ───────────────────────────────────────────────────────────
 *   1. Script starts → openRelayPort() dials background.
 *   2. If the service worker is inactive it wakes on connect (MV3 guarantee).
 *   3. If the Port disconnects (worker idle-killed after 30s inactivity),
 *      reconnect() re-dials with exponential back-off capped at 8 s.
 *   4. Messages buffered while the port is reconnecting are flushed on
 *      successful re-connect.
 *
 * ── Control surface ──────────────────────────────────────────────────────────
 * The content script also listens for RECORDING_STATUS messages from the
 * background and dispatches a CustomEvent on window to toggle isCapturing
 * inside the MAIN-world inject script (the only safe cross-world channel).
 */

import {
  CONTENT_RELAY_PORT_NAME,
  isPageCommandBatchMessage,
  type RelayCommandBatchMessage,
  type PageNavigatedMessage,
} from '../types/messages';

// ─── Port Management ─────────────────────────────────────────────────────────

/** Messages buffered while the relay port is reconnecting. */
const pendingQueue: RelayCommandBatchMessage[] = [];

let relayPort: chrome.runtime.Port | null = null;
let reconnectDelay = 250; // ms, doubles on each failure up to MAX_RECONNECT_DELAY
const MAX_RECONNECT_DELAY = 8_000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function openRelayPort(): void {
  try {
    relayPort = chrome.runtime.connect({ name: CONTENT_RELAY_PORT_NAME });
    reconnectDelay = 250; // reset back-off on success

    // Flush any commands that arrived while we were reconnecting
    if (pendingQueue.length > 0) {
      const toFlush = pendingQueue.splice(0);
      for (const msg of toFlush) {
        relayPort.postMessage(msg);
      }
    }

    relayPort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // Suppress unchecked lastError warnings
      relayPort = null;
      scheduleReconnect();
    });

    // Background can push recording status through this port too
    relayPort.onMessage.addListener((msg: { type: string; payload?: unknown }) => {
      if (msg.type === 'RECORDING_STATUS') {
        const status = (msg.payload as { status: string })?.status;
        const cmd = status === 'recording' ? 'resume' : 'pause';
        window.dispatchEvent(
          new CustomEvent('__canvasLint:control', { detail: { cmd } })
        );
      }
    });

    console.debug('[CanvasLint:Content] Relay port connected.');
  } catch (err) {
    // Extension context might not be ready during very early page load
    console.debug('[CanvasLint:Content] Port open failed, will retry:', err);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    openRelayPort();
  }, reconnectDelay);
}

/** Send a relay batch — buffers if the port is temporarily down. */
function sendBatch(msg: RelayCommandBatchMessage): void {
  if (relayPort) {
    try {
      relayPort.postMessage(msg);
      return;
    } catch {
      // Port may have died between the onDisconnect callback and here
      relayPort = null;
      scheduleReconnect();
    }
  }
  // Buffer while reconnecting (cap at 200 batches = ~3 s of 60fps canvas)
  if (pendingQueue.length < 200) {
    pendingQueue.push(msg);
  }
  // If over the cap we silently drop — acceptable: background buffer is bounded
  // anyway, and the PRD accepts data loss under resource pressure (§4).
}

// ─── Window Message Listener ─────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  // Security: only accept messages from our own frame
  if (event.source !== window) return;

  const data = event.data as unknown;
  if (!isPageCommandBatchMessage(data)) return;

  if (data.payload.length === 0) return; // nothing to relay

  const relayMsg: RelayCommandBatchMessage = {
    type: 'RELAY_COMMAND_BATCH',
    payload: data.payload,
  };

  sendBatch(relayMsg);
});

// ─── Navigation Detection ─────────────────────────────────────────────────────

// When the page navigates the inject script is destroyed, so the new page
// gets a fresh intercept. We notify the background so it can reset the buffer.
window.addEventListener('beforeunload', () => {
  if (!relayPort) return;
  try {
    const nav: PageNavigatedMessage = {
      type: 'PAGE_NAVIGATED',
      payload: {
        tabId: 0, // background will resolve from sender.tab.id
        newUrl: location.href,
      },
    };
    relayPort.postMessage(nav);
  } catch { /* port may already be gone */ }
});

// ─── Proxy Injection ─────────────────────────────────────────────────────────

let hasInjected = false;

function injectProxyScript() {
  if (hasInjected) return;
  hasInjected = true;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject/index.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
  console.debug('[CanvasLint:Content] Detected canvas element. Proxy injected.');
}

function checkForCanvas() {
  if (document.querySelector('canvas')) {
    injectProxyScript();
    return;
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes) {
        for (const n of Array.from(m.addedNodes)) {
          if (n.nodeName === 'CANVAS') {
            injectProxyScript();
            observer.disconnect();
            return;
          }
          if (n instanceof HTMLElement && n.querySelector('canvas')) {
            injectProxyScript();
            observer.disconnect();
            return;
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

openRelayPort();
console.debug('[CanvasLint:Content] Relay initialized (Port-based batching).');
checkForCanvas();
