# CanvasLint 🔬

> A Manifest V3 browser extension that performs accessibility and quality linting on [Canvas LMS](https://www.instructure.com/) pages directly inside Chrome DevTools.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript |
| Build tool | Vite 5 (multi-entry) |
| Extension API | Chrome Manifest V3 |
| Styling | Vanilla CSS (dark mode) |

---

## Project Structure

```
src/
├── manifest.json           # MV3 extension manifest
├── assets/                 # Icons (16/32/48/128 px)
│
├── types/
│   └── messages.ts         # Shared message type definitions (discriminated union)
│
├── background/
│   └── index.ts            # Service worker — message broker & storage
│
├── content/
│   └── index.ts            # Injected content script — DOM linting rules
│
├── devtools/
│   └── index.html          # DevTools bootstrap page (registers panel)
│
├── panel/                  # React DevTools panel
│   ├── index.html
│   ├── main.tsx
│   ├── panel.css
│   ├── PanelApp.tsx
│   └── components/
│       ├── PanelHeader.tsx
│       ├── ResultsList.tsx
│       ├── ResultCard.tsx
│       └── EmptyState.tsx
│
└── popup/                  # Browser action popup
    ├── index.html
    ├── main.tsx
    ├── popup.css
    └── PopupApp.tsx
```

---

## Getting Started

### Install dependencies

```bash
npm install
```

### Development (watch mode)

```bash
npm run dev
```

This runs `vite build --watch` and continuously rebuilds to `dist/` as you edit files.

### Load the extension in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

### Production build

```bash
npm run build
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Canvas LMS Page                     │
│  ┌──────────────────────────────────────────────────┐   │
│  │  content/index.ts                                │   │
│  │  • Runs lint rules against the live DOM          │   │
│  │  • Sends LINT_RESULTS → background               │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
                              │  chrome.runtime.sendMessage
                              ▼
┌──────────────────────────────────────────────────────────┐
│  background/index.ts  (Service Worker)                   │
│  • Routes messages between content ↔ DevTools panel      │
│  • Persists lint results to chrome.storage.local         │
└──────────────────────────────────────────────────────────┘
          │  Port (long-lived)           │
          ▼                             ▼
┌───────────────────┐       ┌──────────────────────┐
│ devtools/         │       │ popup/               │
│ index.html        │       │ PopupApp.tsx         │
│ (registers panel) │       │ • Active/inactive    │
└───────────────────┘       │   status indicator   │
          │                 │ • Quick issue count  │
          ▼                 └──────────────────────┘
┌───────────────────┐
│ panel/            │
│ PanelApp.tsx      │
│ • ResultsList     │
│ • ResultCard      │
│ • PanelHeader     │
└───────────────────┘
```

---

## Lint Rules (Starter Set)

| Rule ID | Severity | Description |
|---|---|---|
| `img-alt` | error | Images missing `alt` attribute |
| `heading-order` | warning | Skipped heading levels |
| `link-text` | error | Non-descriptive link text ("click here", etc.) |

Add new rules to `src/content/index.ts` inside the `runLintRules()` function.

---

## Message Types

All cross-context communication uses the typed union in `src/types/messages.ts`:

| Type | Direction | Purpose |
|---|---|---|
| `DEVTOOLS_INIT` | Panel → Background | Register panel port for a tab |
| `LINT_RESULTS` | Content → Background → Panel | Deliver lint violations |
| `RUN_ANALYSIS` | Panel → Background → Content | Trigger re-analysis |
| `STATUS_UPDATE` | Background → Panel | Extension enable/disable state |
