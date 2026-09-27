// Using React 18 JSX transform

/**
 * Placeholder for panel columns whose data source doesn't exist yet
 * (the render-block parser — see README, "Known limitations").
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="stub">
      <span className="stub__flag">Not implemented</span>
      <p>{children}</p>
      <span className="stub__ref">See README → Known limitations</span>
    </div>
  );
}
