/**
 * Popup component — simple ready indicator since UI is in DevTools.
 */
export function PopupApp() {
  return (
    <div className="popup-root">
      <header className="popup-header">
        <span className="popup-logo" aria-hidden="true">⬡</span>
        <h1 className="popup-title">CanvasLint</h1>
      </header>

      <main className="popup-main">
        <div className="popup-active">
          <p className="popup-status popup-status--active">
            ✓ Ready for Analysis
          </p>
          <p className="popup-issues">
            Open Chrome DevTools <br/>(F12 or Ctrl+Shift+I)<br/> and select the "CanvasLint" tab to debug canvas rendering.
          </p>
        </div>
      </main>
    </div>
  );
}
