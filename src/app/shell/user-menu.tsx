'use client';

import { useEffect, useRef, useState } from 'react';
import { LogoutButton } from '@/modules/platform-security/ui/logout-button';

/** Name + role in the top bar; the menu holds the account actions (logout). Closes on Escape and outside click. */
export function UserMenu({
  name,
  roleLabel,
  menuLabel,
  locale,
}: {
  name: string;
  roleLabel: string;
  menuLabel: string;
  locale: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initial = [...name.trim()][0] ?? '?';
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="user-menu"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={menuLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-line"
      >
        <span className="grid size-8 place-items-center rounded-full bg-sidebar text-sm font-semibold text-white">
          {initial}
        </span>
        <span className="hidden text-start leading-tight sm:block">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block text-xs text-muted">{roleLabel}</span>
        </span>
      </button>
      {open && (
        <div className="card absolute end-0 top-full z-50 mt-2 w-60 p-2 shadow-pop" role="menu">
          <p className="px-2 py-1.5 text-sm sm:hidden">
            <span className="block font-medium">{name}</span>
            <span className="block text-xs text-muted">{roleLabel}</span>
          </p>
          <LogoutButton locale={locale} />
        </div>
      )}
    </div>
  );
}
