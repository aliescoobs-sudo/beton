'use client';

import { useEffect, useRef, useState } from 'react';
import { LogoutButton } from '@/modules/platform-security/ui/logout-button';
import { LanguageSwitch } from './language-switch';

/** Name and role at the end of the top bar; the menu holds the account actions. Closes on Escape and outside click. */
export function UserMenu({
  name,
  roleLabel,
  menuLabel,
  languageLabel,
  darija,
  locale,
}: {
  name: string;
  roleLabel: string;
  menuLabel: string;
  languageLabel: string;
  /** Darija is offered once its module flag is on (or when the account already uses it). */
  darija: boolean;
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

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        data-testid="user-menu"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={menuLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2.5 px-2 py-1 hover:bg-white/10"
      >
        <span className="hidden text-start leading-tight sm:block">
          <span className="block text-sm font-medium">{name}</span>
          <span className="block text-xs text-white/70">{roleLabel}</span>
        </span>
        <span className="grid size-8 place-items-center bg-white text-sm font-bold text-ink">
          {[...name.trim()][0] ?? '?'}
        </span>
      </button>
      {open && (
        <div className="pop absolute end-0 top-full z-50 mt-1 w-60 p-2" role="menu">
          <p className="px-2 py-1.5 text-sm sm:hidden">
            <span className="block font-medium">{name}</span>
            <span className="block text-xs text-muted">{roleLabel}</span>
          </p>
          <LanguageSwitch locale={locale} label={languageLabel} darija={darija} />
          <LogoutButton locale={locale} />
        </div>
      )}
    </div>
  );
}
