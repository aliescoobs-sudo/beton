import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Card({
  className,
  padded = true,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return <div className={cn('card', padded && 'card-pad', className)} {...rest} />;
}
