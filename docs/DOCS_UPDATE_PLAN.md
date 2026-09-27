# Docs update plan

This plan replaces the three legacy docs with an account of what the code actually does. The docs are `CanvasLint_PRD.txt` (2026-04-03), `CanvasLint_Architecture.txt` (2026-04-03), and `CanvasLint_Completion_Report.txt` (2026-04-30). They currently sit at the repo root, not in `docs/legacy/`. Evidence and reproduction details for everything below are in [AUDIT.md](AUDIT.md).

---

## 1. Known discrepancy: is the Render Block parser implemented?

**Neither document is correct, but the completion report is much closer.**

- `architecture.md` (04-03) describes beginPath→fill/stroke/clip grouping, save/restore parent-child framing, and incremental delta parsing as working. **None of that exists in code.**
- `completion-report.md` (04-30) says the heuristics are stubbed and "blocks are just appended as received". The first half is right, but it still overstates the implementation: **no blocks are produced at all**, so there is nothing to append.

Evidence:
- The worker's only parser hook is a comment, `// TODO (Phase 4): feed cmd into BlockParser → accumulate pendingDeltaBlocks` ([src/background/index.ts:111](../src/background/index.ts#L111)). `allRenderBlocks` and `pendingDeltaBlocks` are only ever reset to `[]`.
- The parser's *design* exists as types and a comment describing a single-pass algorithm: `BlockParserState`, `PathBlock`, `ImmediatePaintBlock`, and `LooseCommand` in [src/types/render-blocks.ts](../src/types/render-blocks.ts). Its helper functions (`createInitialParserState`, `pathBlockLabel`, `immediatePaintLabel`) and the method sets `PATH_OPENER_METHODS`, `PATH_TERMINATOR_METHODS`, and `DIRECT_PAINT_METHODS` have **zero callers**.
- Even the design has no save/restore hierarchy. The block types are flat, and nothing models parent-child framing.
- Live check: after 125 captured commands, the panel showed "RENDER BLOCKS 0". The snapshot's `renderBlocks` was empty, and the worker sent no `WORKER_BLOCKS_DELTA` messages.

A side note on the docs' own consistency: the source TODO calls the parser "Phase 4", while the completion report calls it "Phase 5" and marks Phase 4 done.

---

## 2. Claim-by-claim check

Legend: ✅ matches code · ⚠️ partly true / misleading · ❌ false.

### Injection script (`src/inject/index.ts`)
| Claim | Verdict | What the code does |
|---|---|---|
| Runs in the MAIN world and overrides `CanvasRenderingContext2D.prototype` | ✅ | It is injected with a `<script src>` tag, so it runs in the page's world. |
| "Enumerates all Canvas 2D methods" (Arch §1) | ❌ | A hard-coded list of 26 methods plus `drawImage`, `save`, and `restore`, and 18 setters. `roundRect`, `reset`, `filter`, `letterSpacing`, and others are missed, and `OffscreenCanvasRenderingContext2D` is not touched. |
| Calls the native method first, then records it | ✅ | Every wrapper calls the original first. |
| Images/videos become UUID refs carrying `src` | ✅ | But plain **arrays** also become refs, which breaks `setLineDash` replay (AUDIT B4). |
| rAF drain "≤60 times per second" | ⚠️ | Once per animation frame, so it follows the display refresh rate (120/144 Hz is possible), plus eager flushes. |
| Eager flush at 500 commands | ✅ | `MAX_BATCH_SIZE = 500`. |
| WeakMap save-depth counter "allowing the parser to detect stack drift" | ⚠️ | The counter exists and `restore()` at depth 0 sets `stackDrift: true`. **Nothing reads that flag.** |
| Capture starts "from the very first canvas call" (code comment) | ❌ | Injection happens after `document_idle` plus an async script load, so draws made during page load are lost (verified). |
| Pause makes capture cost zero | ❌ | The pause signal never reaches this script (AUDIT S1). |

### Content script (`src/content/index.ts`)
| Claim | Verdict | What the code does |
|---|---|---|
| Lazy injection once a `<canvas>` appears (MutationObserver) | ✅ | It misses canvases that are never attached to the DOM or live in shadow DOM. On canvas-free pages the observer runs forever. |
| "Without polluting non-canvas webpages" | ❌ | It runs on every page: it opens a relay port, listens for messages, and sends `PAGE_NAVIGATED` on every unload. |
| Verifies the sentinel on window messages | ⚠️ | It checks `source === window` plus a public constant, which any page script can forge (AUDIT S5). |
| Long-lived `content-relay` port with back-off capped at 8 s | ✅ | 250 ms doubling to 8 s; `lastError` is read. |
| Queues up to 200 batches while disconnected | ✅ | Batches beyond that are silently dropped. |
| Relays pause/resume into the MAIN world | ❌ | It only listens on the port, but the worker sends control messages through `chrome.tabs.sendMessage`. |
| `all_frames: false` / iframes ignored | ✅ | Set in `public/manifest.json`. |

### Background worker (`src/background/index.ts`)
| Claim | Verdict | What the code does |
|---|---|---|
| Two port families: `content-relay` and `devtools` | ✅ | |
| 10,000-command circular buffer, oldest overwritten | ✅ | But each push copies all 10,000 slots (AUDIT S6). |
| Throttled 250 ms / 4 Hz delta flush | ⚠️ | The timer exists, but it only sends when there are pending blocks, which there never are. **The panel gets no live updates** (AUDIT B3). |
| Tab isolation (Completion Report) | ❌ | One global buffer; every panel gets everything (AUDIT B5). |
| `PAGE_NAVIGATED` clears stale buffers on reload | ⚠️ | It clears the **global** buffer when *any* tab unloads, and it is ignored while paused. |
| `COMMAND_SLICE` "binary chunks" | ❌ | A structured-cloned JSON array of the whole range, starting at 0. |
| Survives worker restarts | ❌ | All state is in memory. An idle-killed worker loses the buffer. |
| `broadcastControlToContent` passes toggles to pages | ❌ | It sends to every tab, and no tab is listening. |

### Panel and replay engine (`src/panel/*`)
| Claim | Verdict | What the code does |
|---|---|---|
| Zustand store holding metadata only, no raw commands | ✅ | Commands live in a hook ref. |
| `subscribeWithSelector` drives replay outside React | ✅ | |
| 50 ms slider debounce | ✅ | |
| Three-column grid (block list, replay canvas, inspector) | ✅ | Two of the three columns are always empty (AUDIT B2). |
| Replay = clear, reset 18 properties, then execute commands 0..N | ⚠️ | 18 properties are reset, but the restore loop runs **after** the reset and brings back stale state (AUDIT S2). |
| "Automated `restore()` while-loop" | ⚠️ | A fixed 64-iteration `for` loop in the wrong position. |
| Image cache loads assets via "async fetch … base64/URL" | ⚠️ | `new Image()` with the captured `src`. Failures are re-fetched on every replay. |
| Gradients and `Path2D` produce ReplayWarnings | ⚠️ | Gradients do (drawn as transparent). `Path2D` fill/stroke/clip **silently replays the wrong path** (AUDIT S4). |
| Replays over 100 ms show a spinner/warning | ⚠️ | The spinner appears on every replay. Slow replays only produce a `console.warn`. |
| Pixel-perfect deterministic replay (Completion Report) | ❌ | Broken by B4 and S2–S4. All canvases are drawn onto one replay canvas, and the DPR scale is lost. |
| "Video replay uses currentSrc" (Completion Report) | ❌ | It loads the video URL into an `<img>`, which always fails. |

### PRD-specific claims
| Claim | Verdict | Notes |
|---|---|---|
| Live State Inspector | ❌ | It only renders parser snapshots, and there is no parser. |
| Stack drift shows a red Replay Warning | ❌ | Not implemented anywhere downstream of `inject`. |
| Hard Reset purges the buffer and kills the `save()` stack | ⚠️ | It purges the worker and panel state. The page-side reset is never delivered. |
| ResizeObserver syncs the replay canvas to `devicePixelRatio` | ⚠️ | The DPR scale is applied and then wiped by `resetTransform()` on each replay. |
| WebGL "explicitly ignores `getContext('webgl')`" | ⚠️ | The outcome is right, but for a different reason: `getContext` isn't touched at all. Only 2D prototypes are patched. |
| Memory "strictly under 150 MB" | ❌ | Unmeasured. The buffer limits count, not bytes, and `data:` URLs are stored per command (AUDIT S7). |
| <15% host frame impact; 200 commands in <100 ms | ⚠️ | No benchmark exists in the repo. Unverified. |
| CORS images degrade gracefully | ⚠️ | Individual assets do. Replay as a whole does not (AUDIT B4). |
| Data structures in PRD §5 | ❌ | The real `RenderBlock` has a numeric `id`, `kind: 'path' \| 'immediate' \| 'loose'`, `startIndex`/`endIndex`, and `label`. It has no `summary`/`commandCount`/`startLogical`, and no `image`/`text`/`clear` kinds. |

---

## 3. Corrected architecture summary (what the code does today)

```
host page ──(prototype wrappers, MAIN world)──► inject/index.js
   │  batches per animation frame (or at 500 cmds) → window.postMessage({__canvasLint:true, …})
   ▼
content/index.js (isolated world, every top-level page)
   │  filters by source===window + sentinel, forwards over Port 'content-relay'
   │  sends PAGE_NAVIGATED on beforeunload
   ▼
background/index.js (MV3 service worker)
   │  one global 10,000-slot ring buffer (all tabs), cleared by any tab's navigation
   │  no parser: render-block list is always empty
   │  answers REQUEST_COMMAND_SLICE with commands[0..N]
   ▼
panel (React + Zustand, DevTools tab)
   │  gets commandCount only from WORKER_SNAPSHOT (on connect)
   │  slider → REQUEST_COMMAND_SLICE → replayEngine.replayCommands(ctx, cmds, N)
   ▼
replay canvas: reset → execute 0..N via a switch; unresolvable refs skipped with warnings
```

**What works:** capturing 2D calls on canvases that exist after page idle; relay with reconnect and back-off; the bounded ring buffer; on-demand slice fetching; deterministic replay of simple fill/stroke/rect/text/transform/image sequences on a single canvas, once the panel has a snapshot.

**What doesn't:** the render-block parser and everything built on it (block list, state inspector, stack-drift warnings, timeline ticks); live command-count updates; pause/resume/reset reaching the page; tab isolation; `setLineDash`, `Path2D`, video, and multi-canvas replay; load-time capture.

**Undocumented design facts worth stating:**
- Commands are indexed by buffer position for slicing. `cmd.index` is a per-page counter and not globally unique.
- Recording is on by default from worker startup.
- The panel reconnects with the same 250 ms → 8 s back-off as the content script.

---

## 4. Voice and authorship note

The current docs read as AI-drafted, and a reviewer will notice. Specific signals:

- **Recycled phrasing across documents written weeks apart.** "Computation-over-memory" appears in both the PRD and the architecture doc. "Determinism" framing, "stack drift", "sentinel", and "Hard Reset & Resync" recur across all three docs and the source comments. The PRD and architecture doc share a date but repeat each other's paragraphs almost word for word. The architecture doc repeats the same four-part template (*Core Function / Inner Workings (The "How") / Integration & Data Flow / Edge Cases & Constraints*) six times, and the completion report reuses the same component-by-component skeleton 27 days later.
- **Inflated register:** "hyper-efficient", "the global brain", "the central nervous system", "mathematically wrap around", "exponential computational collapse", "Academic & PM-Grade".
- **Confident claims the code contradicts** (sections 1 and 2), which is the pattern a careful reader will catch first.
- **Source comments quote a PRD that isn't in the repo.** [src/types/circular-buffer.ts:6-11](../src/types/circular-buffer.ts#L6-L11) quotes "PRD §3 — Buffer Limit" and [src/types/render-blocks.ts:6-8](../src/types/render-blocks.ts#L6-L8) quotes "PRD §2 — Logical Command Grouping". Neither sentence appears in `CanvasLint_PRD.txt`, and its section numbers don't match.
- **The README belongs to a different project** (a Canvas LMS accessibility linter), which suggests it came from a generated scaffold.

**Recommendation.** Rewrite the public README by hand in a first-person, engineering-notes voice, *not* in the voice of these docs. For example: "I wanted to scrub through canvas draw calls the way the Network panel scrubs requests. Here's how it works, what broke, and what I'd do differently." The README should contain:

1. **What it is and a GIF**, recorded after fixing B3 and B4, of `demo/demo.html` being scrubbed.
2. **Install/build:** Node version, `npm ci`, `npm run build`, Load unpacked `dist/`. Say that `npm run dev` needs S11 fixed first.
3. **How it works:** the diagram from section 3 above, plus one paragraph per hop. State facts only; no adjectives.
4. **Decisions and trade-offs, in your own words:** why replay instead of snapshots, why ports instead of `sendMessage`, why rAF batching. Include numbers you actually measured, or none.
5. **Known limitations, stated plainly:** at minimum, whichever of B2/B3/B5/S1–S4 are still unfixed. An honest list reads as stronger engineering than an inflated feature list.
6. **What I'd do next:** the parser, per-tab buffers, `world: "MAIN"` at `document_start`.

**Legacy docs.** Move the three `.txt` files into `docs/legacy/` and add a one-line header to each: "Superseded planning notes; see README for current state." Or delete them. Don't ship them as current documentation, and don't cite their performance figures anywhere unless you have measured them.
