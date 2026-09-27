/**
 * DevTools bootstrap script.
 * Loaded silently by Chrome when DevTools opens — registers the
 * CanvasLint panel inside Chrome DevTools via the chrome.devtools API.
 */
chrome.devtools.panels.create(
  'CanvasLint',           // Panel title in DevTools tab bar
  '/assets/icon32.png',   // Panel icon
  '/panel/index.html',    // The React UI rendered inside the panel
  (panel) => {
    console.log('[CanvasLint] DevTools panel registered', panel);
  }
);
