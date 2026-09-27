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
  connecting:   '[ connecting ]',
  connected:    '[ connected ]',
  disconnected: '[ disconnected ]',
  error:        '[ link error ]',
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
        <img className="panel-header__logo" src="/assets/icon16.png" alt="" />
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
        <span className={`stat${errorCount > 0 ? ' stat--fault' : ''}`}>err <b>{errorCount}</b></span>
        <span className={`stat${warningCount > 0 ? ' stat--fault' : ''}`}>warn <b>{warningCount}</b></span>
        {bufferHasWrapped && (
          <span className="stat stat--fault" title="Circular buffer wrapped — oldest commands dropped">
            buffer wrapped
          </span>
        )}
      </div>

      <div className="panel-header__actions">
        <button
          className={`btn${isAnalysing ? '' : ' btn--rec'}`}
          onClick={onRunAnalysis}
          disabled={!isConnected}
          aria-label={isAnalysing ? 'Pause recording' : 'Start recording'}
          title={isAnalysing ? 'Pause recording' : 'Start recording'}
        >
          {isAnalysing ? '■ Pause' : '● Rec'}
        </button>

        <button
          className="btn"
          onClick={onHardReset}
          disabled={!isConnected}
          aria-label="Hard reset — clear buffer and resync"
          title="Hard Reset & Resync (clears all captured commands)"
        >
          Reset
        </button>
      </div>
    </header>
  );
}
