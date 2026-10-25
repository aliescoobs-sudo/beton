import type { Severity } from '@/modules/rules-engine';
import { cn } from '@/ui';

const STYLE: Record<Severity, { icon: string; className: string }> = {
  risk: { icon: '▲', className: 'text-status-late' },
  urgent: { icon: '◆', className: 'text-signal' },
  important: { icon: '■', className: 'text-amber' },
  probable: { icon: '●', className: 'text-status-ontrack' },
};

/** Severity is always an icon (a shape), a word and a colour: never the colour alone (colour-blind safe, SPEC §3). */
export function SeverityTag({
  severity,
  label,
  className,
}: {
  severity: Severity;
  label: string;
  className?: string;
}) {
  const s = STYLE[severity];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-sm font-semibold', s.className, className)}
      data-severity={severity}
    >
      <span aria-hidden="true">{s.icon}</span>
      <span className="text-ink">{label}</span>
    </span>
  );
}
