'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Brand, cn } from '@/ui';
import type { NavGroup } from './nav-model';

interface ShellLabels {
  brand: string;
  open: string;
  close: string;
  mainNav: string;
  subNav: string;
  search: string;
  searchPlaceholder: string;
}

/**
 * The signed-in frame. A dark ink top bar carries the brand, the main groups as tabs (4px signal-red underline on
 * the current one) and the user menu. Under it come the simulation band (when simulated) and a light band with the
 * current group's pages. On a phone the tabs and pages move into a drawer. Each link has one visible copy, so tests
 * and screen readers see it once.
 */
export function AppShell({
  groups,
  labels,
  homeHref,
  searchHref,
  simBand,
  userMenu,
  assistant,
  children,
}: {
  groups: NavGroup[];
  labels: ShellLabels;
  homeHref: string;
  /** The page that finds a document by its number (a GET form, so it is a link as much as a box). */
  searchHref: string;
  simBand: ReactNode;
  userMenu: ReactNode;
  /** The assistant's button and panel, when the assistant is on for this application; absent otherwise. */
  assistant?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  // The drawer is open for one pathname only, so navigating closes it without an effect.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const drawer = useRef<HTMLDivElement>(null);

  // Longest matching href wins, so /master-data/clients/123 selects Clients and "/fr" only matches the home link.
  const all = groups.flatMap((g) => g.links.map((l) => ({ group: g, link: l })));
  const current = all
    .filter(({ link }) => pathname === link.href || pathname.startsWith(`${link.href}/`))
    .sort((a, b) => b.link.href.length - a.link.href.length)[0];
  const currentGroup = current?.group;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenAt(null);
    document.addEventListener('keydown', onKey);
    drawer.current?.querySelector<HTMLElement>('a')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="on-forest bg-forest text-white">
        <div className="mx-auto flex w-full max-w-[1240px] items-stretch gap-1 px-3 md:gap-4 md:px-8">
          <Link href={homeHref} className="flex items-center" aria-label={labels.brand}>
            {/* Under 160 px the symbol alone (brand rule): on a phone the header has no room for the signature. */}
            <Brand variant="symbol" tone="white" width={48} className="inline-block md:hidden" />
            <Brand tone="white" width={160} className="hidden md:inline-block" />
          </Link>
          <nav aria-label={labels.mainNav} className="hidden flex-1 items-stretch gap-1 md:flex">
            {groups.map((group) => {
              const isCurrent = group.id === currentGroup?.id;
              return (
                <Link
                  key={group.id}
                  href={group.links[0]?.href ?? homeHref}
                  data-testid={`tab-${group.id}`}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={cn(
                    'flex items-center border-b-4 px-2 text-sm font-medium lg:px-2.5',
                    isCurrent
                      ? 'border-citron text-white'
                      : 'border-transparent text-white/70 hover:text-white',
                  )}
                >
                  {group.label}
                </Link>
              );
            })}
          </nav>
          <span className="flex-1 md:hidden" />
          <form action={searchHref} method="get" role="search" className="hidden items-center md:flex">
            <input
              name="q"
              type="search"
              minLength={4}
              maxLength={40}
              required
              dir="ltr"
              autoComplete="off"
              placeholder={labels.searchPlaceholder}
              aria-label={labels.search}
              className="w-24 rounded border border-white/30 bg-white/10 px-2 py-1 text-sm text-white placeholder:text-white/60"
              data-testid="search-box"
            />
          </form>
          <div className="flex items-center gap-0 py-2 md:gap-2">
            {assistant}
            {userMenu}
            <button
              type="button"
              className="px-2 py-1 text-sm font-medium underline decoration-2 underline-offset-4 md:hidden"
              onClick={() => setOpenAt(pathname)}
              aria-expanded={open}
              aria-controls="app-drawer"
              data-testid="menu-button"
            >
              {labels.open}
            </button>
          </div>
        </div>
      </header>

      {simBand}

      {currentGroup && currentGroup.links.length > 1 && (
        <div className="border-b border-rule bg-band">
          <nav
            aria-label={labels.subNav}
            className="mx-auto flex w-full max-w-[1240px] gap-1 overflow-x-auto px-4 md:px-8"
          >
            {currentGroup.links.map((link) => {
              const isCurrent = current?.link.href === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  data-testid={link.testId}
                  aria-current={isCurrent ? 'page' : undefined}
                  className={cn(
                    'whitespace-nowrap border-b-[3px] px-3 py-2.5 text-sm',
                    isCurrent ? 'border-forest font-semibold' : 'border-transparent hover:border-field',
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          ref={drawer}
          id="app-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={labels.mainNav}
        >
          <button
            type="button"
            className="absolute inset-0 bg-graphite/60"
            onClick={() => setOpenAt(null)}
            aria-label={labels.close}
          />
          <div className="on-forest absolute inset-y-0 start-0 flex w-80 max-w-[88vw] flex-col overflow-y-auto bg-forest text-white">
            <div className="flex items-center justify-between px-5 py-4">
              <Brand tone="white" width={160} />
              <button
                type="button"
                onClick={() => setOpenAt(null)}
                className="px-2 text-sm underline decoration-2 underline-offset-4"
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
                placeholder={labels.searchPlaceholder}
                aria-label={labels.search}
                className="w-full rounded border border-white/30 bg-white/10 px-2 py-1.5 text-sm text-white placeholder:text-white/60"
                data-testid="drawer-search-box"
              />
            </form>
            <nav className="flex-1 px-5 pb-8">
              {groups.map((group) => (
                <div key={group.id} className="mt-5 first:mt-0">
                  <p className="font-display text-base font-bold text-white/70">{group.label}</p>
                  <ul className="mt-1">
                    {group.links.map((link) => (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          data-testid={`drawer-${link.testId}`}
                          aria-current={current?.link.href === link.href ? 'page' : undefined}
                          className={cn(
                            'block border-s-4 py-2 ps-3 text-sm',
                            current?.link.href === link.href
                              ? 'border-citron font-semibold'
                              : 'border-transparent text-white/85',
                          )}
                        >
                          {link.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-[1240px] flex-1 px-4 py-8 md:px-8 md:py-10">{children}</main>
    </div>
  );
}
