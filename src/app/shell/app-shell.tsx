'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/ui';
import { NavGlyph } from './icons';
import type { NavGroup } from './nav-model';

interface ShellLabels {
  brand: string;
  open: string;
  close: string;
  userMenu: string;
  mainNav: string;
}

/**
 * The signed-in frame: sidebar on the inline-start side (right in Arabic), a phone menu that opens the same
 * navigation as a drawer, and a top bar with the page title, the simulation pill and the user menu.
 * The navigation is rendered once, so it is also the only copy of each link for tests and screen readers.
 */
export function AppShell({
  groups,
  labels,
  simPill,
  userMenu,
  children,
}: {
  groups: NavGroup[];
  labels: ShellLabels;
  simPill: ReactNode;
  userMenu: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // The drawer is open for one pathname only, so navigating closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (value: boolean) => setOpenAt(value ? pathname : null);
  const drawer = useRef<HTMLElement>(null);

  // Longest matching href wins, so /master-data/clients/123 highlights Clients and "/fr" only matches the home link.
  const all = groups.flatMap((g) => g.links);
  const active = all
    .filter((l) => pathname === l.href || pathname.startsWith(`${l.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenAt(null);
    document.addEventListener('keydown', onKey);
    drawer.current?.querySelector<HTMLElement>('a')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[16.5rem_minmax(0,1fr)]">
      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink/40 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}
      <aside
        id="app-nav"
        ref={drawer}
        aria-label={labels.mainNav}
        className={cn(
          'flex-col bg-sidebar text-sidebar-ink md:sticky md:top-0 md:flex md:h-dvh md:w-auto',
          open ? 'fixed inset-y-0 start-0 z-50 flex w-72 max-w-[85vw]' : 'hidden',
        )}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <span className="text-base font-semibold tracking-wide">{labels.brand}</span>
          <button
            type="button"
            className="rounded p-1 text-sidebar-muted hover:text-sidebar-ink md:hidden"
            onClick={() => setOpen(false)}
            aria-label={labels.close}
          >
            ×
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-6">
          {groups.map((group) => (
            <div key={group.id} className="mt-4 first:mt-0">
              {group.label && (
                <p className="px-2 pb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-sidebar-muted">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.links.map((link) => {
                  const current = active?.href === link.href;
                  return (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        data-testid={link.testId}
                        aria-current={current ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm',
                          current
                            ? 'bg-sidebar-hover font-medium text-white shadow-[inset_3px_0_0_var(--color-accent)] rtl:shadow-[inset_-3px_0_0_var(--color-accent)]'
                            : 'text-sidebar-ink hover:bg-sidebar-hover',
                        )}
                      >
                        <NavGlyph name={link.icon} />
                        <span className="min-w-0 truncate">{link.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5 md:px-8">
          <button
            type="button"
            className="btn btn-secondary btn-sm md:hidden"
            onClick={() => setOpen(true)}
            aria-expanded={open}
            aria-controls="app-nav"
            data-testid="menu-button"
          >
            ☰ <span>{labels.open}</span>
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="topbar-title">
            {active?.label ?? labels.brand}
          </p>
          {simPill}
          {userMenu}
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}
