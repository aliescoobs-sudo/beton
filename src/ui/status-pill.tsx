import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** The five account statuses of D21/D22 (colours are fixed tokens), plus a neutral pill for non-status labels. */
export type PillStatus = 'paid' | 'ontrack' | 'due' | 'late' | 'cancelled' | 'neutral';

/** A coloured dot and an ink label: the colour is never the only signal, and the label always has contrast. */
export function StatusPill({
  status,
  className,
  ...rest
}: { status: PillStatus } & HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('pill', `pill-${status}`, className)} data-status={status} {...rest} />;
}
