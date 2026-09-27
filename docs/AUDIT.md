# CanvasLint pre-publication audit

Audit date: 2026-09-27. Scope: working tree at `D:\College\Projects\CanvasLint` (git branch `master`, **zero commits**).
Nothing in the repo was modified except for adding this file and `DOCS_UPDATE_PLAN.md`.

**How I checked.** I read every source file in `src/`, `devtools/`, `public/`, and the build configs. Then I copied the tree (without `node_modules`, `dist`, `.git`) to a scratch directory to simulate a fresh clone, and ran `npm ci`, `npm run build`, `npm run type-check`, `npm run lint`, `npm audit`, and `npm run dev`. I loaded the built `dist/` as an unpacked extension in Playwright's bundled Chromium (build 1243). Three scripted probes served test pages over HTTP and drove both the extension's ports and the real panel UI, with `chrome.devtools` stubbed.

Each finding is tagged with how it was confirmed:
- **[live]**: reproduced in the running extension.
- **[code]**: confirmed by reading the source.
- **[unverified]**: plausible, but not reproduced.

Note: the legacy docs are **not** in `docs/legacy/`. They are the three `.txt` files at the repo root (`CanvasLint_PRD.txt`, `CanvasLint_Architecture.txt`, `CanvasLint_Completion_Report.txt`).

---

## Answers at a glance

| Question | Answer |
|---|---|
| 3. Secrets / private data | No API keys, tokens, or credentials anywhere. Git history is empty (unborn branch, 0 objects), so there is nothing to scrub. One absolute personal path appears in `lint.txt`. The icons carry C2PA content credentials that label them as AI-generated. Details are under S13 and O1. |
| 4. CORS "graceful degradation" | **Partly true.** Unresolvable images are skipped with a warning and don't throw, and ordinary cross-origin `http(s)` images actually *load* in the panel because of the extension's host permission. **But the replay as a whole is not graceful:** a single `setLineDash([...])` in the range throws a `TypeError` and aborts the entire replay (B4). See also S10. |
| 4. postMessage sentinel | Spoofable by any script on the page (verified). On its own this matters little, because the page can draw anything anyway. It becomes a real problem when combined with the global cross-tab buffer, no schema validation, and the panel fetching page-supplied URLs (S5). |
| 5. README / LICENSE / .gitignore / .env.example | README describes a **different product** (B1). No LICENSE (B6). `.gitignore` exists and is adequate. No `.env.example`, and none is needed because the code reads no environment variables. |
| 5. Fresh clone builds and loads? | **Yes for `npm install && npm run build` → Load unpacked `dist/`** (verified). **No for `npm run dev` on Windows**: content/inject scripts are never built (S11). |
| 6. Genuinely MV3? | **Yes.** `manifest_version: 3`, module service worker, `action`, separate `host_permissions`, object-form `web_accessible_resources`, no remote code. Longevity risks are listed at the end. |

---

## BLOCKER

Fix these before the repo goes public. For B2 and B3, an honest README that scopes them as "not yet working" is an acceptable alternative to fixing them.

### B1. README describes a different product [code]
[README.md](../README.md) describes "accessibility and quality linting on Canvas LMS pages", with lint rules (`img-alt`, `heading-order`), `chrome.storage.local` persistence, a `LINT_RESULTS` message type, and `ResultsList.tsx`/`ResultCard.tsx` components. None of that exists. The actual project is a Canvas 2D rendering recorder/replayer. The README's file tree also lists `src/manifest.json` and `src/devtools/index.html`, while the real locations are `public/manifest.json` and `devtools/`. This is the first file a reviewer opens.

### B2. The Render Block parser does not exist, so every block-driven feature is permanently empty [live]
There is no parser code, not even a stub that appends. `allRenderBlocks` and `pendingDeltaBlocks` are never written to except to reset them: [src/background/index.ts:50-54](../src/background/index.ts#L50-L54), [src/background/index.ts:108-112](../src/background/index.ts#L108-L112) (`// TODO (Phase 4): feed cmd into BlockParser`). The helper functions in [src/types/render-blocks.ts](../src/types/render-blocks.ts) (`createInitialParserState`, `pathBlockLabel`, `immediatePaintLabel`) and the method sets in [src/types/canvas-commands.ts:235-248](../src/types/canvas-commands.ts#L235-L248) have no callers. Consequences, all confirmed in the live panel ("RENDER BLOCKS 0" after 125 captured commands):
- The Block List always shows the empty state.
- The State Inspector can never show anything, because it only displays a selected block's `stateSnapshot`.
- The timeline has no block tick marks.
- Stack-drift warnings are never shown. `inject` sets `stackDrift: true` ([src/inject/index.ts:256-262](../src/inject/index.ts#L256-L262)), but nothing reads that field, and the replay engine never emits `'state-stack-drift'`.

### B3. The panel never learns about new commands after it connects [live]
`WORKER_BLOCKS_DELTA` is the only live update channel, and it is sent only when `pendingDeltaBlocks` is non-empty ([src/background/index.ts:71-84](../src/background/index.ts#L71-L84)). Because of B2 it never is, so `commandCount` in the panel only changes on a full `WORKER_SNAPSHOT` (connect/reconnect).
Reproduction: open the panel, then load a page that draws. After 4 s the slider still has `max=0`, is disabled, and the counter reads "—". Only reloading the panel shows "125 cmds". Opening DevTools first and then interacting with the page is the normal workflow, so in practice the timeline looks broken.

### B4. Replay throws and aborts on any `setLineDash` call [live]
`serializeArgs` turns **every** object argument into a `SerializedRef`, including plain arrays ([src/inject/index.ts:101-107](../src/inject/index.ts#L101-L107)). So `ctx.setLineDash([4, 2])` is recorded as a ref, and the replay calls `ctx.setLineDash(refObject)` ([src/panel/replayEngine.ts:292](../src/panel/replayEngine.ts#L292)). That throws `TypeError: ... must have a callable @@iterator property`. The replay loop has no per-command try/catch ([src/panel/replayEngine.ts:362-365](../src/panel/replayEngine.ts#L362-L365)), so the entire replay is abandoned whenever the scrubbed range includes a dash change. The canvas is left half-drawn, and the error goes only to the console.
Fix at the root: in `serializeArgs`, pass arrays of numbers through (they structured-clone fine), and wrap `executeCommand` in a try/catch that records an issue and continues.

### B5. One global buffer for all tabs, and any tab's navigation wipes it [live]
- A single buffer is shared by every tab ([src/background/index.ts:21](../src/background/index.ts#L21), [:47](../src/background/index.ts#L47)). A panel for tab A receives tab B's commands (verified: the slice contained commands from both test tabs). The completion report's "Tab Isolation" claim is false. The `tabId → port` map exists, but `broadcastToAllPanels` ignores it and the buffer isn't keyed.
- The content script runs on every page and sends `PAGE_NAVIGATED` on every `beforeunload` ([src/content/index.ts:141-153](../src/content/index.ts#L141-L153)). The worker responds by resetting the global buffer ([src/background/index.ts:102-105](../src/background/index.ts#L102-L105)). Verified: the buffer went 20 → 0 when an unrelated, canvas-free tab navigated.

Fix: key buffers by `port.sender.tab.id` and have panels subscribe by tab. That single change also resolves most of S5.

### B6. No LICENSE [code]
Without a license, a public repo is "all rights reserved", so nobody may legally reuse it. Add one (MIT is the usual portfolio default).

---

## SHOULD FIX

### S1. Pause/Resume/Reset never reach the page [live]
The worker sends control messages with `chrome.tabs.sendMessage` ([src/background/index.ts:261-273](../src/background/index.ts#L261-L273)). The content script has **no** `chrome.runtime.onMessage` listener; it only listens on its relay port ([src/content/index.ts:71-79](../src/content/index.ts#L71-L79)). So the MAIN-world `isCapturing` flag never changes. Verified: after clicking Pause, the page still posted 5 of 5 batches, and the worker merely discards them ([src/background/index.ts:93](../src/background/index.ts#L93)). The claim that "postMessage cost is zero while paused" is false.
There is also a latent bug: `'reset'` is mapped to `'idle'` ([:263](../src/background/index.ts#L263)), which the content script would translate to `pause` ([src/content/index.ts:74](../src/content/index.ts#L74)). Once the channel works, Reset would therefore stop capture.
Fix: send control over the existing relay ports (track them by tab id), and map reset → reset.

### S2. `resetContext` restores the previous replay's state after resetting it [live]
[src/panel/replayEngine.ts:142-177](../src/panel/replayEngine.ts#L142-L177) clears pixels, sets the defaults, and *then* calls `restore()` 64 times. If the previous replay ended inside an unmatched `save()`, those restores pop the saved state back on top of the defaults. Verified: a prior `fillStyle='#f00'; translate(50,0); save()` survived the reset (`fillStyle: '#ff0000', translateX: 50`). Replay is therefore not deterministic.
Fix: run the restore loop first, then `resetTransform()`, then `clearRect`, then set the defaults. `restore()` never throws, so the try/catch is dead code.

### S3. Anything drawn before injection is never captured [live]
The content script runs at `document_idle` and then appends an async `<script src>` ([src/content/index.ts:159-168](../src/content/index.ts#L159-L168)). Verified: a synchronous `fillRect` at page load was missing from the buffer. So a canvas drawn once on load, such as a chart or a static diagram, records nothing, and neither does the initial frame of the repo's own `demo/demo.html`. The comment at [src/inject/index.ts:35-40](../src/inject/index.ts#L35-L40), which says "recorded from the very first canvas call", is wrong.
Two more gaps: canvases that are never attached to the DOM (common offscreen buffers) and canvases inside shadow DOM never trigger injection. Meanwhile, on canvas-free pages the subtree `MutationObserver` is never disconnected.
Fix: declare `inject/index.js` as a content script with `"world": "MAIN"` and `"run_at": "document_start"` (Chrome 111+). That removes the lazy-injection machinery, the `<script>` tag, and the web-accessible resource (O2).

### S4. `fill(path)`, `stroke(path)`, and `clip(path)` with a `Path2D` replay the wrong geometry, with no warning [code]
[src/panel/replayEngine.ts:213-233](../src/panel/replayEngine.ts#L213-L233) replaces a `Path2D` argument with a bare `ctx.fill()`/`ctx.stroke()`/`ctx.clip()` on whatever the current path is. The comment says "path itself was replayed via path commands", but `Path2D` construction isn't intercepted, so that's false. The pixels come out wrong and no warning is shown. Separately, `stroke` ignores its argument in both branches. The PRD says these cases generate `ReplayWarnings`; they don't.

### S5. postMessage trust boundary [live]
- The sentinel `__canvasLint` is a public constant ([src/types/messages.ts:37](../src/types/messages.ts#L37)). `event.source !== window` ([src/content/index.ts:122](../src/content/index.ts#L122)) only filters out iframes, because host-page scripts share `window`. Verified: a page script posting `{__canvasLint: true, type: 'CANVAS_COMMAND_BATCH', payload: [...]}` got its fabricated commands into the buffer.
- Same-tab spoofing by itself is low-impact: the page controls the MAIN world and could simply draw. Three things amplify it:
  1. **Cross-tab:** the content-script listener is registered on *every* page, canvas or not, and the buffer is global (B5). Any site open in another tab can inject into, flood (10k cap → evicts real data), or wipe the session you're debugging.
  2. **No validation:** `method`, `args`, and `value` are trusted as-is by the worker and replay engine. A malformed value (e.g. `set:font` with a non-stringifiable object) throws and aborts the replay.
  3. **Panel-side fetches:** `SerializedRef.data` is page-controlled and handed to `new Image().src` inside the extension page ([src/panel/replayEngine.ts:64-75](../src/panel/replayEngine.ts#L64-L75)). Because of `<all_urls>` host permissions, the extension origin isn't bound by CORS (verified: a no-CORS cross-origin image loaded). So a page can make the panel issue GETs to arbitrary URLs, including intranet hosts, whenever the developer scrubs. `crossOrigin='anonymous'` means no cookies are sent and the page can't read the response, so severity is low.
- Fix, in order of value: per-tab buffers (B5); validate `method` against the known union and check arg types in the worker; allow only `http:`, `https:`, and `data:image/` in `ref.data`. A secret nonce isn't achievable in a MAIN world the page controls, so treat all relayed data as untrusted rather than adding more sentinel logic.

### S6. The ring buffer copies all 10,000 slots on every push [live]
`pushToBuffer` does `buffer.items.slice()` per command ([src/types/circular-buffer.ts:100-119](../src/types/circular-buffer.ts#L100-L119)), which is O(capacity), even though its comment says "O(1)". Measured: 3.1 ms per 500-command batch, or about 186 ms of worker CPU per second at 60 batches/s. Nothing needs the immutability. Mutate in place.

### S7. The "<150 MB" memory ceiling is not guaranteed [code]
The buffer limits the command *count*, not bytes. Every `drawImage` stores the image's full `src` in `SerializedRef.data` ([src/inject/index.ts:91-95](../src/inject/index.ts#L91-L95)). For `data:` URLs that string can be megabytes, repeated per call, across 10,000 slots. `fillText` strings are unbounded too. Nothing in the repo measures memory.
Fix: intern asset URLs once per `refId` and store only the id in each command. Then either measure and state the real figure, or drop the claim.

### S8. Unused and overly broad permissions [code]
`storage`, `scripting`, and `activeTab` ([public/manifest.json:41-45](../public/manifest.json#L41-L45)) are never used. Chrome Web Store review rejects unused permissions. `<all_urls>` combined with an every-page content script means every tab opens a port to the worker and keeps it awake. If store publication is ever planned, justify the broad host permission in the listing.

### S9. Google Fonts loaded by the panel and popup [code]
[panel/index.html:7-12](../panel/index.html#L7-L12) and `popup/index.html` fetch from `fonts.googleapis.com` every time DevTools opens. That is a third-party request carrying the user's IP address, and the styling breaks offline. Bundle the two fonts or use a system font stack.

### S10. Video sources and failed images are re-fetched on every replay [code]
`resolveRef` treats `HTMLVideoElement` like an image and loads `currentSrc` into `new Image()` ([src/panel/replayEngine.ts:94-105](../src/panel/replayEngine.ts#L94-L105)). That always fails, and `onerror` deletes the cache entry "to retry next replay". Every scrub step re-requests the video URL (and any broken image or page-scoped `blob:` URL), and the warning says "Image not yet loaded" forever. It doesn't throw, but it is wasted network traffic and a misleading message. Cache failures, and give video and `blob:` sources a distinct `unresolved-ref` warning.

### S11. `npm run dev` is broken on Windows [live]
In [package.json:7](../package.json#L7), the script chains three `vite build --watch` commands with `&`. npm on Windows runs scripts through `cmd.exe`, where `&` runs commands one after another. The first watcher never exits, so `dist/content/` and `dist/inject/` are never built (verified after 30 s). Also, the main config has `emptyOutDir: true`, so on POSIX its rebuilds may delete the other two outputs [unverified]. Fix: run the three watchers from a small Node script, or add `concurrently`.

### S12. Dev-dependency vulnerabilities [live]
`npm audit`: 0 in production deps, and 9 in dev deps (6 high): vite ≤6.4.2, esbuild ≤0.24.2 (the dev server lets any website read responses), postcss, browserslist, brace-expansion, js-yaml, nanoid, @babel/core, baseline-browser-mapping. All are build-time only, but GitHub will show Dependabot alerts on day one. Upgrade Vite.

### S13. Stale scratch files in the repo root [code]
`lint.txt`, `ts_errors.log`, `ts_errors.txt`, and `project_structure.txt` are UTF-16 leftovers:
- `lint.txt` contains the absolute path `D:\College\Projects\CanvasLint\src\...`.
- The two `ts_errors` files reference files that no longer exist (`ResultCard.tsx`, `LintResult`). A fresh `tsc --noEmit` and `eslint` both pass cleanly now.
- `project_structure.txt` lists a `generate_tree.js` that doesn't exist.

Delete all four before the first commit.

### S14. Replay fidelity gaps not covered elsewhere [code]
- Commands from every canvas on the page are replayed onto one replay canvas; `canvasId` is never filtered ([src/panel/useReplayEngine.ts:169](../src/panel/useReplayEngine.ts#L169)).
- The replay canvas is sized to the panel, not the source canvas.
- The DPR `ctx.scale()` applied by the ResizeObserver ([src/panel/components/ReplayCanvas.tsx:43-50](../src/panel/components/ReplayCanvas.tsx#L43-L50)) is wiped by `resetTransform()` on every replay, so HiDPI screens show replays at the wrong scale.
- Resizing clears the canvas without re-running the replay.

### S15. Replay warnings accumulate without bound, and the slice cache goes stale [code]
Every replay appends all of its issues again ([src/panel/useReplayEngine.ts:172-180](../src/panel/useReplayEngine.ts#L172-L180)), so scrubbing back and forth inflates the header's warning count. The local command cache is reused whenever `cursor < cached.length` ([:160-163](../src/panel/useReplayEngine.ts#L160-L163)), so after new commands arrive or the buffer wraps, replay uses outdated data.

---

## OPTIONAL

- **O1. Icons.** All four `public/assets/icon*.png` files are the *same* 1024×1024, 411 KB **JPEG** with a `.png` extension. They also embed Google C2PA content credentials that declare the image AI-generated (`digitalSourceType: trainedAlgorithmicMedia`, SynthID). That isn't secret, but anyone who inspects the file can see it. Decide whether you're fine with that. Either way, export real PNGs at 16/32/48/128, which saves about 1.6 MB.
- **O2. Extension fingerprinting.** `inject/index.js` and `assets/*` are web-accessible to all sites ([public/manifest.json:51-56](../public/manifest.json#L51-L56)), so any site can detect the extension. `"use_dynamic_url": true` fixes that, and S3's `world: "MAIN"` change makes the entry unnecessary.
- **O3. Template leftovers.** These come from the LMS-linter scaffold: `PanelHeader` props `isAnalysing`, `onRunAnalysis`, and `errorCount` (always `0`), and the popup text "Ready for Analysis".
- **O4. Dead protocol code.** `RELAY_COMMAND`/`PageCommandMessage` (deprecated), `BUFFER_WRAPPED` (sent, never read), `WORKER_WARNING` (handled, never sent), and `isWorkerToPanelMessage` (unused). The `messages.ts` header says "No `any` types are used", but the worker uses `as any` for slice requests.
- **O5.** Add `"engines": { "node": ">=18" }` and state the Node version in the README. Under npm 12, esbuild's postinstall is blocked by `allowScripts`. The build still succeeded here, but a note saves someone a detour.
- **O6. Interception coverage.** The method list is hard-coded ([src/inject/index.ts:181-187](../src/inject/index.ts#L181-L187)), not enumerated as the architecture doc claims. Not covered: `roundRect`, `reset`, `filter`, `letterSpacing`, `direction`, `createPattern`/gradients (captured only as opaque refs), and all of `OffscreenCanvasRenderingContext2D`. Document this list.
- **O7.** The timeline slider is a controlled `<input type=range>` with a 50 ms debounce, and it is disabled during each replay. It may stutter or drop the drag mid-scrub [unverified].
- **O8.** Content scripts orphaned by an extension reload retry `connect` every 8 s forever. It is harmless console noise.
- **O9.** Source maps ship in `dist/`. That's fine for GitHub, but strip them for a store build.

---

## Longevity (item 6)

- **Genuinely MV3:** confirmed; see the table above. It loads without warnings in current Chromium.
- **MAIN-world injection via a `<script src>` web-accessible resource** works today, including on a page with `script-src 'self'` CSP (verified). The MV3-native path is a `world: "MAIN"` content script, which is less likely to be restricted and fixes S3 and O2 as well.
- **Service-worker lifetime:** all state lives in worker globals. Chrome terminates an idle worker after about 30 s without events, and the delta `setInterval` does not keep it alive. After a page stops drawing (a static canvas), the buffer can disappear and the panel reconnects to an empty snapshot. Either keep the buffer in the DevTools panel page, which lives as long as DevTools is open, or document the limitation.
- **`--load-extension` was removed from branded Chrome builds** (Chrome 137+). Manual "Load unpacked" is unaffected, but any automated test must use Chromium or Chrome for Testing, as this audit did.
- **Toolchain age:** ESLint 8 with `.eslintrc.cjs` is end-of-life (flat config is required from ESLint 9/10). Other versions: Vite 5 (current 8), typescript-eslint 7, React 18, and `@types/chrome` 0.0.279 (current 0.3.x). The build prints Vite's "CJS Node API is deprecated" warning because `package.json` lacks `"type": "module"`. Fix that before any major Vite upgrade.
