'use client';

import { usePathname } from 'next/navigation';
import { setMyLocaleAction } from './locale-actions';

const LABELS = { fr: 'Français', ar: 'العربية', ary: 'الدارجة' } as const;

/** The account's main language: saved on the account, then the same page is shown in it (REQUIREMENTS-V1 §13). */
export function LanguageSwitch({
  locale,
  label,
  darija,
}: {
  locale: string;
  label: string;
  darija: boolean;
}) {
  const pathname = usePathname();
  return (
    <div className="px-2 py-1.5" data-testid="language-switch">
      <span className="block text-xs text-muted">{label}</span>
      <div className="mt-1 flex gap-1">
        {(Object.keys(LABELS) as (keyof typeof LABELS)[])
          .filter((l) => darija || l !== 'ary')
          .map((l) => (
            <button
              key={l}
              type="button"
              aria-current={l === locale}
              data-testid={`language-${l}`}
              className={l === locale ? 'btn font-bold' : 'btn'}
              onClick={async () => {
                const r = await setMyLocaleAction(l);
                if (r.ok) window.location.assign(pathname.replace(/^\/(fr|ar|ary)(?=\/|$)/, `/${l}`));
              }}
            >
              {LABELS[l]}
            </button>
          ))}
      </div>
    </div>
  );
}
