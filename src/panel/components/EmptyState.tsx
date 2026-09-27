// Using React 18 JSX transform

interface EmptyStateProps {
  isAnalysing: boolean;
}

export function EmptyState({ isAnalysing }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        {isAnalysing ? '⟳' : '⬡'}
      </div>
      <p className="empty-state__title">
        {isAnalysing ? 'Waiting for canvas rendering…' : 'No commands recorded'}
      </p>
      <p className="empty-state__subtitle">
        {isAnalysing
          ? 'Interact with the host page to generate canvas rendering operations.'
          : 'Click "Record" to intercept rendering commands.'}
      </p>
    </div>
  );
}
