// Using React 18 JSX transform
import type { ConnectionStatus } from '../../types/app-state';

interface PanelHeaderProps {
  errorCount:        number;
  warningCount:      number;
  isAnalysing:       boolean;
  onRunAnalysis:     () => void;
  onHardReset:       () => void;
  connectionStatus:  ConnectionStatus;
  bufferHasWrapped:  boolean;
}

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting:   '⏳ Connecting…',
  connected:    '● Connected',
  disconnected: '○ Disconnected',
  error:        '✕ Error',
};

export function PanelHeader({
  errorCount,
  warningCount,
  isAnalysing,
  onRunAnalysis,
  onHardReset,
  connectionStatus,
  bufferHasWrapped,
}: PanelHeaderProps) {
  const isConnected = connectionStatus === 'connected';

  return (
    <header className="panel-header">
      <div className="panel-header__brand">
        <span className="panel-header__logo" aria-hidden="true">⬡</span>
        <span className="panel-header__title">CanvasLint</span>
        <span
          className={`panel-header__conn panel-header__conn--${connectionStatus}`}
          aria-live="polite"
          aria-label={`Connection status: ${connectionStatus}`}
        >
          {CONNECTION_LABEL[connectionStatus]}
        </span>
      </div>

      <div className="panel-header__stats">
        {bufferHasWrapped && (
          <span className="badge badge--warning" title="Circular buffer wrapped — oldest commands dropped">
            Buffer full
          </span>
        )}
        {errorCount > 0 && (
          <span className="badge badge--error">{errorCount} error{errorCount !== 1 ? 's' : ''}</span>
        )}
        {warningCount > 0 && (
          <span className="badge badge--warning">{warningCount} warning{warningCount !== 1 ? 's' : ''}</span>
        )}
        {errorCount === 0 && warningCount === 0 && !bufferHasWrapped && (
          <span className="badge badge--ok">All clear</span>
        )}
      </div>

      <div className="panel-header__actions">
        <button
          className={`btn-run ${isAnalysing ? 'btn-run--active' : ''}`}
          onClick={onRunAnalysis}
          disabled={!isConnected}
          aria-label={isAnalysing ? 'Pause recording' : 'Start recording'}
          title={isAnalysing ? 'Pause recording' : 'Start recording'}
        >
          {isAnalysing ? '⏸ Pause' : '▶ Record'}
        </button>

        <button
          className="btn-reset"
          onClick={onHardReset}
          disabled={!isConnected}
          aria-label="Hard reset — clear buffer and resync"
          title="Hard Reset & Resync (clears all captured commands)"
        >
          ↺ Reset
        </button>
      </div>
    </header>
  );
}
