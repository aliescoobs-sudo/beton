/** Permanent badge while the clock is simulated (SPEC-clock §4). Presentational: the layout supplies the text. */
export function SimBadge({ label, at }: { label: string; at: string }) {
  return (
    <div
      role="status"
      className="bg-violet-700 px-4 py-1 text-center text-sm font-medium text-white"
      data-testid="sim-badge"
    >
      {label} — {at}
    </div>
  );
}
