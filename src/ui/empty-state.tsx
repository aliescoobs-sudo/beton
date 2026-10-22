import type { ReactNode } from 'react';
import { cn } from './cn';

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      className={cn('card flex flex-col items-center gap-3 border-dashed px-6 py-12 text-center', className)}
      {...rest}
    >
      {icon && <div className="text-muted">{icon}</div>}
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="max-w-md text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}
