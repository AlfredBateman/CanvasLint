/**
 * BlockList.tsx  (full rebuild)
 *
 * Scrollable list of render blocks received from the background parser.
 * Each entry shows: row index, kind badge, label (monospace), command span.
 *
 * Clicking a block:
 *   1. Moves the timeline cursor to that block's endIndex.
 *   2. If the block has a stateSnapshot, populates the Live State Inspector.
 *
 * Auto-scroll: in live mode (cursor === null), the list auto-scrolls to the
 * last item as new blocks arrive. Auto-scroll is suppressed once the user
 * makes a selection.
 */

import { useEffect, useRef } from 'react';
import {
  usePanelStore,
  selectRenderBlocks,
  selectSelectedBlockId,
  selectTimelineCursor,
  selectActions,
} from '../usePanelStore';
import type { RenderBlock } from '../../types/render-blocks';

const KIND_LABEL: Record<RenderBlock['kind'], string> = {
  path:      'PATH',
  immediate: 'DRAW',
  loose:     'STATE',
};

export function BlockList() {
  const renderBlocks     = usePanelStore(selectRenderBlocks);
  const selectedBlockId  = usePanelStore(selectSelectedBlockId);
  const cursor           = usePanelStore(selectTimelineCursor);
  const { selectBlock, setTimelineCursor } = usePanelStore(selectActions);

  const bottomRef   = useRef<HTMLDivElement>(null);
  const isLive      = cursor === null;

  // Auto-scroll to bottom only in live mode with no selection
  useEffect(() => {
    if (isLive && selectedBlockId === null) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [renderBlocks.length, isLive, selectedBlockId]);

  function handleSelect(block: RenderBlock) {
    setTimelineCursor(block.endIndex);
    if ('stateSnapshot' in block) {
      selectBlock(block.id, block.stateSnapshot);
    } else {
      selectBlock(block.id, null as any);
    }
  }

  return (
    <div className="block-list" role="list" aria-label="Render block timeline">
      {renderBlocks.map((block, i) => {
        const isSelected = block.id === selectedBlockId;
        const cmdSpan    = block.endIndex - block.startIndex + 1;

        return (
          <button
            key={block.id}
            role="listitem"
            className={[
              'block-item',
              `block-item--${block.kind}`,
              isSelected ? 'block-item--selected' : '',
            ].join(' ')}
            onClick={() => handleSelect(block)}
            aria-current={isSelected ? 'true' : undefined}
            aria-label={`Block ${i + 1}: ${block.label}`}
          >
            <span className="block-item__index" aria-hidden="true">
              {(i + 1).toString().padStart(3, '0')}
            </span>
            <span className="block-item__badge" aria-hidden="true">
              {KIND_LABEL[block.kind]}
            </span>
            <span className="block-item__label" title={block.label}>
              {block.label}
            </span>
            <span
              className="block-item__count"
              aria-label={`${cmdSpan} commands`}
            >
              ×{cmdSpan}
            </span>
          </button>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
