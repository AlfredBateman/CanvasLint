# CanvasLint

I wanted to scrub through Canvas 2D draw calls the way the Network panel lets
you scrub through requests — pick a point in a page's rendering history and
see exactly what the canvas looked like at that moment. This is a Manifest V3
Chrome extension that does that: it records every `CanvasRenderingContext2D`
call a page makes, replays them into a DevTools panel, and lets you drag a
slider through the command history.

It is not an accessibility or DOM linter, despite the name — that's a leftover
from an earlier scaffold this project was built on top of.

---

## Install / build

Requires Node 18+.

```bash
npm ci
npm run build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the `dist/` folder.

Open [demo/demo.html](demo/demo.html) in a tab, then open Chrome DevTools on
that tab and switch to the **CanvasLint** panel.

`npm run dev` (watch mode) is currently broken on Windows — its three `vite
build --watch` processes are chained with `&`, which npm runs through
`cmd.exe`, where `&` runs commands sequentially instead of in parallel, so the
first watcher never exits and the other two never build. Until that's fixed,
re-run `npm run build` and reload the unpacked extension after each change.

---

## How it works

```
host page ──(prototype wrappers, MAIN world)──► inject/index.js
   │  batches per animation frame (or every 500 commands) →
   │  window.postMessage({ __canvasLint: true, ... })
   ▼
content/index.js (isolated world, every top-level page)
   │  filters by source === window + a sentinel flag, forwards over a
   │  long-lived port ('content-relay'); sends PAGE_NAVIGATED on unload
   ▼
background/index.js (MV3 service worker)
   │  one 10,000-slot ring buffer, shared across all tabs
   │  answers REQUEST_COMMAND_SLICE with commands[0..N]
   ▼
panel (React + Zustand, DevTools tab)
   │  timeline slider → REQUEST_COMMAND_SLICE → replayEngine.replayCommands
   ▼
replay canvas: reset context → execute commands 0..N via a switch;
unresolvable refs (e.g. an unloaded image) are skipped with a warning
```

`inject/index.ts` wraps every `CanvasRenderingContext2D` method it knows about
(a fixed list — `roundRect`, `filter`, and a few newer methods aren't covered
yet) so it can call through to the real implementation and record the call.
Objects passed as arguments (images, gradients, `Path2D`) can't cross the
`postMessage`/port boundary, so they're replaced with an opaque reference
token (`SerializedRef`) carrying enough information (like an image's `src`)
for the replay side to reconstruct something close to the original call.

---

## Decisions and trade-offs

- **Replay from a command log, not periodic snapshots.** A snapshot approach
  would need to serialize actual pixel data or full canvas state at intervals,
  which is heavier and loses fidelity between snapshots. Replaying a command
  log from scratch is exact for anything that doesn't depend on an
  unresolvable external reference, at the cost of having to re-run the whole
  history up to the scrub point on every frame.
- **Long-lived ports instead of one-shot `sendMessage`.** The relay
  (`content-relay`) and DevTools connections are both high-frequency and
  bidirectional (batches flowing one way, replay/control messages flowing the
  other), so a persistent `chrome.runtime.connect()` port made more sense than
  repeated `sendMessage` round-trips. Both sides reconnect with the same
  exponential back-off (250ms doubling to 8s).
- **rAF batching over per-call messages.** Sending a `postMessage` for every
  single `fillRect` call would flood the isolated world's message queue on
  anything that draws per-frame. Commands are queued in the MAIN world and
  flushed once per animation frame, with an eager flush at 500 queued
  commands so a synchronous burst (e.g. procedural generation in a tight
  loop) doesn't grow unbounded between frames.

---

## Known limitations

This is mid-build. The capture pipeline, ring buffer, and basic replay work;
several things built on top of them don't yet:

- **No render-block parser.** The "Block List" and "State Inspector" panel
  sections are permanently empty, and the timeline has no block tick marks.
  There's a type-level design for this (`src/types/render-blocks.ts`) but no
  code ever calls into it — commands are recorded but never grouped.
- **The panel doesn't learn about new commands live.** The live-update
  channel only fires when there are new render blocks to send, which never
  happens (see above). In practice this means the command counter and
  timeline only update when the panel reconnects, not while you're watching a
  page draw.
- **One capture buffer shared across every open tab.** The ring buffer isn't
  keyed by tab, so a panel open on tab A can receive tab B's commands, and any
  tab navigating clears the buffer for all of them.
- **Pause/Resume/Reset don't reach the page.** The worker sends these as
  `chrome.tabs.sendMessage`, but the content script only listens on its relay
  port, so none of the three controls currently change what's being captured.

A few smaller known gaps: draws made before the injection script attaches
(synchronous draws at page load) aren't captured; `Path2D` fill/stroke/clip
replays against whatever the *current* path happens to be rather than the
path that was actually passed in; and only one canvas's worth of commands is
ever replayed even if a page has several.

## What's next

The render-block parser, per-tab buffers, and moving injection to a
`world: "MAIN"` content script at `document_start` (removes the lazy
`<script src>` injection entirely and fixes the load-time capture gap) are
the three biggest next steps.
