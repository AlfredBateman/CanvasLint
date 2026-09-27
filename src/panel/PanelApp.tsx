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
      <main className="panel-main">
        {/* Col 1: block list sidebar */}
        <section className="pane" aria-label="Render blocks">
          <div className="pane__header">
            <span>Render blocks</span>
            <span className="pane__meta">{renderBlocks.length}</span>
          </div>
          {hasContent ? <BlockList /> : (
            <EmptyState>
              Commands are captured and replayable from the timeline, but no
              parser groups them into render blocks yet, so this list stays empty.
            </EmptyState>
          )}
        </section>

        {/* Col 2: replay canvas */}
        <section className="pane" aria-label="Replay canvas">
          <div className="pane__header">Replay canvas</div>
          <ReplayCanvas portRef={portRef} />
        </section>

        {/* Col 3: state inspector */}
        <section className="pane" aria-label="Context state">
          <div className="pane__header">Context state</div>
          {hasContent ? <StateInspector /> : (
            <EmptyState>
              Context-state snapshots are attached to render blocks. With no
              block parser, there is no snapshot to inspect.
            </EmptyState>
          )}
        </section>
      </main>
    </div>
  );
}
