'use client';

import Link from 'next/link';
import { cn } from '@/ui';
import { NavIcon } from './icons';
import type { NavGroup } from './nav-model';

/**
 * The phone's bottom bar (prototype Phone.dc): the home screen and up to three groups, each 44 px or more tall, label under the icon.
 * It shows only the groups `buildNav` already filtered for this role and module flags (UI only, no permission is decided here); the drawer
 * under the Menu button still lists everything the role may open. Hidden from md up, where the top tabs take over. Test ids carry a
 * `bottom-` prefix so the tabs of the top bar stay unique.
 */
export function BottomBar({
  groups,
  currentGroupId,
  homeHref,
  label,
}: {
  groups: NavGroup[];
  currentGroupId: string | undefined;
  homeHref: string;
  label: string;
}) {
  const items = groups.filter((g) => g.links.length > 0).slice(0, 4);
  if (items.length <= 1) return null;
  return (
    <nav
      aria-label={label}
      data-testid="bottom-bar"
      className="on-forest fixed inset-x-0 bottom-0 z-40 flex bg-forest text-white md:hidden print:hidden"
    >
      {items.map((group) => {
        const isCurrent = group.id === currentGroupId;
        return (
          <Link
            key={group.id}
            href={group.id === 'dashboard' ? homeHref : (group.links[0]?.href ?? homeHref)}
            aria-current={isCurrent ? 'page' : undefined}
            data-testid={`bottom-${group.id}`}
            className={cn(
              'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 border-t-4 px-1 text-xs',
              isCurrent ? 'border-citron font-semibold text-white' : 'border-transparent text-white/80',
            )}
          >
            <NavIcon id={group.id} />
            <span className="max-w-full truncate">{group.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
