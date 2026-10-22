import type { ReactNode } from 'react';

/**
 * Permanent badge while the clock is simulated (SPEC-clock §4): a compact pill in the top bar. Presentational: the
 * layout supplies the text. The optional children (the owner's advance control) open in a popover under the pill.
 */
export function SimBadge({ label, at, children }: { label: string; at: string; children?: ReactNode }) {
  const pill = (
    <>
      <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
      <span className="font-semibold tracking-wide">{label}</span>
      <span className="text-muted" dir="ltr">
        {at}
      </span>
    </>
  );
  const pillClass =
    'inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-line-strong bg-canvas px-3 py-1 text-xs';
  return (
    <div role="status" data-testid="sim-badge" className="relative">
      {children ? (
        <details className="group">
          <summary className={`${pillClass} cursor-pointer list-none`}>{pill}</summary>
          <div className="card absolute end-0 top-full z-50 mt-2 w-[min(22rem,90vw)] p-3 text-ink shadow-pop">
            {children}
          </div>
        </details>
      ) : (
        <span className={pillClass}>{pill}</span>
      )}
    </div>
  );
}
