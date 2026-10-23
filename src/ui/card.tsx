import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** A ruled panel: 3px ink rule on top, flat surface, no shadow and no radius. */
export function Card({
  className,
  padded = true,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return <div className={cn('panel', !padded && 'p-0', className)} {...rest} />;
}
