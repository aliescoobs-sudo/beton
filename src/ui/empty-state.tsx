import type { ReactNode } from 'react';
import { cn } from './cn';

/** A full-width band that says what is missing and invites the first entry. */
export function EmptyState({
  title,
  description,
  action,
  className,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <section className={cn('band', className)} {...rest}>
      <h2 className="font-display max-w-3xl text-2xl font-bold leading-snug md:text-3xl">{title}</h2>
      {description && <p className="mt-3 max-w-2xl text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </section>
  );
}
