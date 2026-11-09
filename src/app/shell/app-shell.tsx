'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Brand, cn } from '@/ui';
import { findCurrent } from './drawer-model';
import { MobileDrawer } from './mobile-drawer';
import type { NavGroup } from './nav-model';

interface ShellLabels {
  brand: string;
  open: string;
  close: string;
  mainNav: string;
  subNav: string;
  search: string;
  searchPlaceholder: string;
  noMatch: string;
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
  const menuButton = useRef<HTMLButtonElement>(null);
  const subNav = useRef<HTMLElement>(null);

  // The current link: the longest matching href wins, so /master-data/clients/123 selects Clients and "/fr" only matches the home link.
  const current = findCurrent(groups, pathname);
  const currentGroup = current?.group;

  // Closing the drawer by hand (Escape, close button, backdrop) gives the focus back to the Menu button.
  const closeDrawer = () => {
    setOpenAt(null);
    menuButton.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeDrawer();
    document.addEventListener('keydown', onKey);
    drawer.current?.querySelector<HTMLElement>('button, a, input')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // On a phone the sub-navigation scrolls: bring the current page into view so the strip does not open on the wrong side.
  useEffect(() => {
    subNav.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname]);

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
              ref={menuButton}
              className="inline-flex min-h-11 min-w-11 items-center justify-center px-3 text-sm font-medium underline decoration-2 underline-offset-4 md:hidden"
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
            ref={subNav}
            aria-label={labels.subNav}
            className="scroll-hint mx-auto flex w-full max-w-[1240px] gap-1 overflow-x-auto px-4 md:px-8"
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
                    'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-[3px] px-3 text-sm md:min-h-0 md:py-2.5',
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
        <MobileDrawer
          groups={groups}
          labels={{
            mainNav: labels.mainNav,
            close: labels.close,
            search: labels.search,
            searchPlaceholder: labels.searchPlaceholder,
            noMatch: labels.noMatch,
          }}
          searchHref={searchHref}
          pathname={pathname}
          onClose={closeDrawer}
          panelRef={drawer}
        />
      )}

      <main className="mx-auto w-full max-w-[1240px] flex-1 px-4 py-8 md:px-8 md:py-10">{children}</main>
    </div>
  );
}
