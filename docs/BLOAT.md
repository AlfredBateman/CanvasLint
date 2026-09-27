# Bloat / Over-Engineering Audit

Scope: repo-wide, over-engineering and repo-hygiene only (no correctness/security — see `docs/AUDIT.md` for that pass). Repo is a zero-commit working tree (branch `master`), so "before first commit" is the natural cutline for hygiene items.

## Already confirmed by AUDIT.md — not re-analyzed here

These were confirmed dead/removable by the prior audit. Listed for completeness so this report is a full removal checklist; effort in this pass went to what AUDIT.md didn't cover.

- **O1** — `public/assets/icon{16,32,48,128}.png` are four copies of the same 421KB file, actually a JPEG mislabeled `.png`, duplicated again in `dist/assets/`. Replace with correctly-sized real PNGs.
- **O4** — dead protocol code: `RELAY_COMMAND`/`PageCommandMessage`, `BUFFER_WRAPPED`, `WORKER_WARNING`, `isWorkerToPanelMessage` (no callers).
- **S12** — 9 dev-dependency vulnerabilities (6 high): vite, esbuild, postcss, browserslist, brace-expansion, js-yaml, nanoid, @babel/core, baseline-browser-mapping.
- **S13** — stale root scratch files: `lint.txt`, `ts_errors.log`, `ts_errors.txt`, `project_structure.txt`.
- **B2** — dead parser helpers in `src/types/render-blocks.ts` and method sets in `src/types/canvas-commands.ts:235-248` (no callers).

## BLOCKER

Fix before first commit — largest dead-code mass and shipped-surface issues.

- `delete:` entire dead reducer/state model — `ConnectionState`, `TimelineState`, `SelectionState`, `WorkerState`, `AppState`, `initialAppState`, and all 9 `Action` interfaces + `AppAction` union — superseded by the Zustand store in `usePanelStore.ts`. Only `RecordingStatus`, `ConnectionStatus`, and `ReplayWarning` from this file are imported anywhere. Nothing else in it has a caller. [`src/types/app-state.ts:44-52,65-96,121-139,155-201,213-293`] (~185 lines, ~9KB)
- `delete:` `public/manifest.json` declares `storage` and `scripting` permissions but `chrome.storage`/`chrome.scripting` are never called anywhere in `src/`. Unused permissions also draw extra Chrome Web Store review scrutiny for no benefit. [`public/manifest.json:41-45`]
- `delete:` `src/assets/` and `src/devtools/` are empty directories — vestigial scaffolding. Real assets live in `public/assets/`; the real devtools bootstrap is at root `devtools/index.ts`. [`src/assets/`, `src/devtools/`]

## SHOULD FIX

- `shrink:` `background/index.ts` special-cases `REQUEST_COMMAND_SLICE` with two `as any` casts to bypass `isPanelToWorkerMessage`, because `CommandSliceRequestMessage` was left out of the `PanelToWorkerMessage` union in `messages.ts` even though the runtime type-guard's `Set` already includes `'REQUEST_COMMAND_SLICE'`. Add it to the union and delete the any-cast branch. [`src/background/index.ts:137-153`, `src/types/messages.ts:133-138`]
- `yagni:` `useReplayEngine.ts` polls `portRef` on a 250ms `setInterval` just to re-attach a message listener, because (per its own comment) there's no way to hook `useWorkerPort`'s internal connect event from outside. Have `useWorkerPort` expose an `onMessage` callback/ref instead of polling for port identity changes. [`src/panel/useReplayEngine.ts:97-135`]
- `shrink:` the same hand-written exponential-backoff formula (250ms start, ×2 doubling, 8s cap) is implemented twice — once in `src/content/index.ts` (out of scope, kept as-is per README trade-off) and independently again in `src/panel/useWorkerPort.ts`. Extract one shared `reconnectWithBackoff` helper; have the panel copy call it instead of re-deriving the same constants. [`src/content/index.ts:47-96`, `src/panel/useWorkerPort.ts:36,42-44,93,121-130`]
- `delete:` `demo/demo.html` and `demo/index.html` are two overlapping hand-written manual-test fixtures (both draw circles/paths/text/save-restore on a canvas with a button). Neither is referenced by `vite.config.ts`, package scripts, or any test. Keep one. [`demo/demo.html`, `demo/index.html`]

## OPTIONAL

- `delete:` `replayEngine.ts`'s `case 'stroke'` branches on whether the arg is a `Path2D` ref, but both branches call `ctx.stroke()` — the if/else is dead, collapse to one line. [`src/panel/replayEngine.ts:225-233`]
- `yagni:` `PanelHeader`'s `errorCount` prop is hard-coded to `0` at its only call site (no error-tracking exists in the app), so the "N errors" badge, its pluralization, and the `errorCount === 0` branch are permanently-dead flexibility. Drop the prop until there's a real error source. [`src/panel/PanelApp.tsx:61`, `src/panel/components/PanelHeader.tsx:5,52-54,58`]
- `yagni:` `PopupApp.tsx` is 100% static markup (no state, props, or handlers) yet is mounted through React + `react-dom` + `StrictMode`. Replace with plain HTML in `popup/index.html` and delete the React entry point. [`src/popup/PopupApp.tsx`, `src/popup/main.tsx`]
- `yagni:` `selectBufferHasWrapped` and `selectInspectedTabId` are exported from `usePanelStore.ts` but never imported anywhere (`PanelApp.tsx` reads `bufferHasWrapped` via an inline selector instead). Delete the two unused named selectors. [`src/panel/usePanelStore.ts:267,271`]

**keep, document trade-off:** nothing new found inside the four excluded areas (rAF batching/eager-flush in `src/inject`, the `circular-buffer.ts` structure, the `src/content` port back-off, the Zustand slice-subscription pattern in `src/panel`) beyond what was already scoped out going in — no findings to report there.

Net from this pass: roughly **350-400 lines** plausibly deletable (dominated by the ~185-line `app-state.ts` reducer). No dependency drops.

## Size audit

`git ls-files --others --exclude-standard` (i.e. everything that would be tracked once committed, respecting the current `.gitignore`): **54 files, 1,978 KB (1.98 MB)** total.

- `.gitignore` (currently `node_modules/`, `dist/`, `*.local`, `.DS_Store`, `Thumbs.db`) is working correctly: no `node_modules/`, `dist/`, `.zip`, or `.map` files show up as trackable. Nothing to clean up on that front.
- It does **not** yet cover the S13 scratch files (`lint.txt`, `ts_errors.log`, `ts_errors.txt`, `project_structure.txt`) — add a rule for them (or just delete them per S13 and skip the rule) so they can't reappear and get committed by accident.
- The four O1 icon files are real (if bloated/mislabeled) source assets in `public/assets/` — not a gitignore candidate, they need to be fixed at the source, not excluded. Their `dist/assets/` duplicates are already covered by the `dist/` ignore rule.
- No `.zip` packages found anywhere in the tree.
- Byte breakdown, top of the list: the four 421KB icons alone are **1,684,896 bytes — 85% of the entire repo's trackable size.** Next-largest are `package-lock.json` (123KB, normal/expected), `docs/AUDIT.md` (21.5KB), and `src/panel/panel.css` (18.4KB, unremarkable for a CSS file this app's size).

## Dependency audit

`npx depcheck` output: one hit, `Unused devDependencies: @types/chrome`.

This is a **false positive** — verified before flagging it as such:
- `tsconfig.json` has no explicit `"types"` array, so TypeScript auto-includes all `@types/*` packages ambiently; `@types/chrome` is never `import`ed because it doesn't need to be.
- `chrome.*` APIs (`chrome.runtime.onConnect`, `chrome.runtime.lastError`, `chrome.tabs.sendMessage`, etc.) are used extensively in `src/background/index.ts` and elsewhere — removing the package would break type-checking.

No unused dependency was found. Nothing here would clear an S12 vulnerability — S12's vulnerable packages (vite, esbuild, postcss, browserslist, brace-expansion, js-yaml, nanoid, @babel/core, baseline-browser-mapping) are all transitive build-tool dependencies pulled in by `vite` itself, not standalone unused packages; the fix there is upgrading vite (per AUDIT.md), not removing anything.

## Total size: now vs. after cleanup

- **Now (trackable size):** 1.98 MB
- **After removing everything flagged here + everything AUDIT.md already slated for removal:** roughly **0.35-0.4 MB** — an ~80% reduction, almost entirely from fixing O1 (four 421KB mislabeled icons → a handful of correctly-sized real PNGs, likely tens of KB total). The remaining items (S13's ~5KB, `render-blocks.ts`/`canvas-commands.ts` dead code's ~14KB, `app-state.ts`'s ~9KB, demo consolidation's ~3KB, and the smaller OPTIONAL items) are individually minor against the icon fix but are still worth doing for code-health, not size.
