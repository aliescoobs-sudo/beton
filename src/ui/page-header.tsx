import type { ReactNode } from 'react';

/** The one h1 of a page (Helvetica Neue stack), under a 3px Forêt rule, with its description and main actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-3 border-t-[3px] border-forest pt-4">
      <div className="min-w-0">
        <h1 className="text-3xl md:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}
