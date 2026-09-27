/**
 * PanelApp.tsx — assembles the full panel layout.
 *
 * Layout (CSS grid 3 rows):
 *   Row 1: PanelHeader
 *   Row 2: TimelineSlider
 *   Row 3: [BlockList | ReplayCanvas + StateInspector]  (3-column sub-grid)
 */

import { useCallback } from 'react';
import { useWorkerPort }   from './useWorkerPort';
import {
  usePanelStore,
  selectConnectionStatus,
  selectRecordingStatus,
  selectWarnings,
  selectActions,
} from './usePanelStore';
import { PanelHeader }    from './components/PanelHeader';
import { TimelineSlider } from './components/TimelineSlider';
import { BlockList }      from './components/BlockList';
import { ReplayCanvas }   from './components/ReplayCanvas';
import { StateInspector } from './components/StateInspector';
import { EmptyState }     from './components/EmptyState';

export function PanelApp() {
  const { sendToWorker, portRef } = useWorkerPort();

  const connectionStatus  = usePanelStore(selectConnectionStatus);
  const recordingStatus   = usePanelStore(selectRecordingStatus);
  const warnings          = usePanelStore(selectWarnings);
  const renderBlocks      = usePanelStore((s) => s.renderBlocks);
  const bufferHasWrapped  = usePanelStore((s) => s.bufferHasWrapped);
  const { hardReset }     = usePanelStore(selectActions);

  const handleToggleRecording = useCallback(() => {
    if (recordingStatus === 'recording') {
      sendToWorker({ type: 'PAUSE_RECORDING' });
    } else {
      sendToWorker({ type: 'START_RECORDING' });
    }
  }, [recordingStatus, sendToWorker]);

  const handleHardReset = useCallback(() => {
    hardReset();
    sendToWorker({
      type:    'HARD_RESET',
      payload: { tabId: chrome.devtools.inspectedWindow.tabId },
    });
  }, [hardReset, sendToWorker]);

  const warningCount = warnings.filter((w) => w.kind !== 'buffer-full').length
    + (bufferHasWrapped ? 1 : 0);
  const hasContent   = renderBlocks.length > 0;

  return (
    <div className="panel-root" data-connection={connectionStatus}>

      {/* Row 1 — Header */}
      <PanelHeader
        errorCount={0}
        warningCount={warningCount}
        isAnalysing={recordingStatus === 'recording'}
        onRunAnalysis={handleToggleRecording}
        onHardReset={handleHardReset}
        connectionStatus={connectionStatus}
        bufferHasWrapped={bufferHasWrapped}
      />

      {/* Row 2 — Timeline scrubber */}
      <TimelineSlider />

      {/* Row 3 — main content */}
      <div className="panel-main">
        {/* Col 1: block list sidebar */}
        <div className="block-list-pane">
          <div className="block-list-pane__header">
            <span>Render Blocks</span>
            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {renderBlocks.length}
            </span>
          </div>
          {hasContent ? <BlockList /> : <EmptyState isAnalysing={recordingStatus === 'recording'} />}
        </div>

        {/* Col 2: replay canvas */}
        <div className="replay-pane">
          <div className="replay-pane__header">Replay Canvas</div>
          <ReplayCanvas portRef={portRef} />
        </div>

        {/* Col 3: state inspector */}
        <div className="inspector-pane">
          <div className="inspector-pane__header">Context State</div>
          <StateInspector />
        </div>
      </div>
    </div>
  );
}
