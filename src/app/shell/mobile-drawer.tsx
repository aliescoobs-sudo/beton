'use client';

import Link from 'next/link';
import { type RefObject, useState } from 'react';
import { Brand, cn } from '@/ui';
import { findCurrent, initialOpenId, isDirect, matchLinks, toggleSection } from './drawer-model';
import type { NavGroup } from './nav-model';

export interface DrawerLabels {
  mainNav: string;
  close: string;
  search: string;
  searchPlaceholder: string;
  noMatch: string;
}

/** A chevron that points to the inline end (right in French, left in Arabic) when the section is closed and down when it is open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0 transition-transform', open ? 'rotate-90' : 'rtl:-scale-x-100')}
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

const ROW = 'flex min-h-12 w-full items-center text-sm';

/**
 * The phone drawer as an accordion. It receives the groups that the server already filtered by permission and module flag (`buildNav`) and only
 * decides which one is expanded: that is UI state, never an authorization. It is mounted only while the drawer is open, so each opening starts
 * from the section of the current route.
 */
export function MobileDrawer({
  groups,
  labels,
  searchHref,
  pathname,
  onClose,
  panelRef,
}: {
  groups: NavGroup[];
  labels: DrawerLabels;
  searchHref: string;
  pathname: string;
  onClose: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  const [openId, setOpenId] = useState<string | null>(() => initialOpenId(groups, pathname));
  const [query, setQuery] = useState('');
  const current = findCurrent(groups, pathname);
  const matches = matchLinks(groups, query);
  const searching = query.trim() !== '';

  const linkClass = (active: boolean, indented = false) =>
    cn(
      ROW,
      'border-s-4 pe-3',
      indented ? 'ps-8' : 'ps-4',
      active ? 'border-citron font-semibold' : 'border-transparent text-white/85',
    );

  return (
    <div
      className="fixed inset-0 z-50 md:hidden"
      id="app-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={labels.mainNav}
    >
      <button
        type="button"
        className="absolute inset-0 bg-graphite/60"
        onClick={onClose}
        aria-label={labels.close}
        tabIndex={-1}
      />
      <div
        ref={panelRef}
        className="on-forest absolute inset-y-0 start-0 flex w-80 max-w-[88vw] flex-col overflow-y-auto bg-forest text-white"
      >
        <div className="flex items-center justify-between ps-5 pe-2 py-2">
          <Brand tone="white" width={160} />
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 min-w-11 items-center justify-center px-3 text-sm underline decoration-2 underline-offset-4"
            data-testid="drawer-close"
          >
            {labels.close}
          </button>
        </div>
        <form action={searchHref} method="get" role="search" className="px-5 pb-3">
          <input
            name="q"
            type="search"
            minLength={4}
            maxLength={40}
            required
            dir="ltr"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={labels.searchPlaceholder}
            aria-label={labels.search}
            className="min-h-11 w-full rounded border border-white/30 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60"
            data-testid="drawer-search-box"
          />
        </form>
        <nav className="flex-1 pb-8" aria-label={labels.mainNav}>
          {searching ? (
            matches.length ? (
              <ul data-testid="drawer-matches">
                {matches.map((m) => (
                  <li key={m.href}>
                    <Link
                      href={m.href}
                      data-testid={`drawer-${m.testId}`}
                      aria-current={current?.link.href === m.href ? 'page' : undefined}
                      className={cn(
                        linkClass(current?.link.href === m.href),
                        'flex-col items-start justify-center py-1',
                      )}
                    >
                      <span>{m.label}</span>
                      <span className="text-xs font-normal text-white/60">{m.groupLabel}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-3 text-sm text-white/70" data-testid="drawer-no-match">
                {labels.noMatch}
              </p>
            )
          ) : (
            groups.map((group) => {
              if (isDirect(group)) {
                const link = group.links[0]!;
                const active = current?.link.href === link.href;
                return (
                  <Link
                    key={group.id}
                    href={link.href}
                    data-testid={`drawer-${link.testId}`}
                    aria-current={active ? 'page' : undefined}
                    className={linkClass(active)}
                  >
                    {group.label}
                  </Link>
                );
              }
              const open = openId === group.id;
              const listId = `drawer-sec-${group.id}`;
              return (
                <div key={group.id}>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={listId}
                    onClick={() => setOpenId((id) => toggleSection(id, group.id))}
                    data-testid={`drawer-section-${group.id}`}
                    className={cn(
                      ROW,
                      'justify-between ps-5 pe-5 font-display text-base font-bold',
                      current?.group.id === group.id ? 'text-white' : 'text-white/70',
                    )}
                  >
                    <span>{group.label}</span>
                    <Chevron open={open} />
                  </button>
                  <ul id={listId} hidden={!open}>
                    {group.links.map((link) => {
                      const active = current?.link.href === link.href;
                      return (
                        <li key={link.href}>
                          <Link
                            href={link.href}
                            data-testid={`drawer-${link.testId}`}
                            aria-current={active ? 'page' : undefined}
                            className={linkClass(active, true)}
                          >
                            {link.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
        </nav>
      </div>
    </div>
  );
}
