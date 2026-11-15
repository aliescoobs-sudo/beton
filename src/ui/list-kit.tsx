import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { buttonClass } from './button';
import { hrefWith, type Page, type SearchParams, type SortDir } from './list-model';

/**
 * The shared list pattern (T18-UI C): filters row, status chips, sortable column headers, pagination, loading and error states, and the
 * Excel export button (only on screens that already have an export route). All of it is plain server-rendered HTML driven by the URL, so
 * it works without JavaScript, mirrors in Arabic (logical properties only) and never decides what a user may see: the page still checks
 * its own permission and loads only what the door returns.
 */

/** A GET form: the filter fields are its children, the buttons follow. Reset is a link to the bare screen. */
export function FilterBar({
  children,
  applyLabel,
  resetLabel,
  resetHref,
  label,
  applyTestId,
  className,
  ...rest
}: {
  children: ReactNode;
  applyLabel: string;
  resetLabel: string;
  resetHref: string;
  /** Accessible name of the search region. */
  label: string;
  applyTestId?: string;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <form
      method="get"
      role="search"
      aria-label={label}
      className={cn('form-band mb-4 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4', className)}
      {...rest}
    >
      {children}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
        <button type="submit" className={buttonClass('primary')} data-testid={applyTestId}>
          {applyLabel}
        </button>
        <Link href={resetHref} className={buttonClass('ghost')}>
          {resetLabel}
        </Link>
      </div>
    </form>
  );
}

export interface Chip {
  /** Value of the param ('' = all). */
  value: string;
  label: string;
  count?: number;
}

/** Status chips: one link per value of a param. The current one carries aria-current and a check mark, so colour is never the only signal. */
export function StatusChips({
  chips,
  current,
  param = 'status',
  path,
  q,
  label,
}: {
  chips: Chip[];
  current: string;
  param?: string;
  path: string;
  q: SearchParams;
  label: string;
}) {
  return (
    <nav aria-label={label} className="mb-4 flex flex-wrap gap-2" data-testid="status-chips">
      {chips.map((c) => {
        const on = c.value === current;
        return (
          <Link
            key={c.value || 'all'}
            href={hrefWith(path, q, { [param]: c.value || null })}
            aria-current={on ? 'true' : undefined}
            data-chip={c.value || 'all'}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 border-2 px-3 text-sm font-medium md:min-h-9',
              on
                ? 'border-forest bg-forest text-white'
                : 'border-rule bg-surface text-ink hover:border-structure',
            )}
            style={{ borderRadius: 'var(--radius-control)' }}
          >
            {on && <span aria-hidden="true">✓</span>}
            {c.label}
            {c.count !== undefined && <bdi dir="ltr">({c.count})</bdi>}
          </Link>
        );
      })}
    </nav>
  );
}

/** A sortable column header: a link that toggles the direction; aria-sort tells assistive technology which column is ordered. */
export function SortTh({
  id,
  sort,
  path,
  q,
  children,
  numeric,
}: {
  id: string;
  sort: { key: string; dir: SortDir } | null;
  path: string;
  q: SearchParams;
  children: ReactNode;
  numeric?: boolean;
}) {
  const active = sort?.key === id;
  const next: SortDir = active && sort?.dir === 'asc' ? 'desc' : 'asc';
  return (
    <th
      aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(numeric && 'is-num')}
    >
      <Link
        href={hrefWith(path, q, { sort: id, dir: next })}
        className="inline-flex items-center gap-1 font-semibold hover:underline"
        data-testid={`sort-${id}`}
      >
        {children}
        <span aria-hidden="true" className={cn('text-xs', !active && 'opacity-40')}>
          {active ? (sort?.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </Link>
    </th>
  );
}

/** Previous / next with "from–to of total". Absent when everything fits on one page. */
export function Pagination({
  page,
  path,
  q,
  labels,
}: {
  page: Page<unknown>;
  path: string;
  q: SearchParams;
  labels: { prev: string; next: string; range: string; nav: string };
}) {
  if (page.total === 0) return null;
  return (
    <nav
      aria-label={labels.nav}
      className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm"
      data-testid="pagination"
    >
      <p data-testid="pagination-range">
        <bdi dir="ltr">{labels.range}</bdi>
      </p>
      {page.pages > 1 && (
        <div className="flex items-center gap-2">
          {page.page > 1 ? (
            <Link
              href={hrefWith(path, q, { page: page.page - 1 })}
              rel="prev"
              className={buttonClass('secondary', true)}
            >
              {labels.prev}
            </Link>
          ) : (
            <span className={cn(buttonClass('secondary', true), 'opacity-45')} aria-disabled="true">
              {labels.prev}
            </span>
          )}
          <span aria-current="page">
            <bdi dir="ltr">
              {page.page} / {page.pages}
            </bdi>
          </span>
          {page.page < page.pages ? (
            <Link
              href={hrefWith(path, q, { page: page.page + 1 })}
              rel="next"
              className={buttonClass('secondary', true)}
            >
              {labels.next}
            </Link>
          ) : (
            <span className={cn(buttonClass('secondary', true), 'opacity-45')} aria-disabled="true">
              {labels.next}
            </span>
          )}
        </div>
      )}
    </nav>
  );
}

/** The Excel export button, for a screen that ALREADY has an export route (none is built by the look-and-feel pass). */
export function ExportButton({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className={buttonClass('secondary')} data-testid="export-excel" download>
      {label}
    </a>
  );
}

/** The loading state: skeleton rows, announced once as busy; with prefers-reduced-motion there is no pulse. */
export function LoadingState({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" data-testid="list-loading">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">
        <div className="h-9 w-2/3 bg-band" />
        {[0, 1, 2, 3, 4].map((n) => (
          <div key={n} className="h-12 w-full bg-band" />
        ))}
      </div>
    </div>
  );
}
