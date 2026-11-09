'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { CompanyProfile } from '../../domain/company';

const INPUT = 'input mt-1';
const FIELDS = [
  ['legalName', 'legalName'],
  ['legalForm', 'legalForm'],
  ['ice', 'ice'],
  ['ifNumber', 'ifNumber'],
  ['rcNumber', 'rcNumber'],
  ['patente', 'patente'],
  ['address', 'address'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['rib', 'rib'],
] as const;

/** The owner's form for our legal identity: saving writes a new version that starts on the date given (today by default). */
export function CompanyForm({
  current,
  save,
}: {
  current: CompanyProfile | null;
  save: (input: unknown) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useTranslations('ledger.company');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: Record<string, string | null> = {};
    for (const [name] of FIELDS) input[name] = String(data.get(name) ?? '').trim();
    const from = String(data.get('effectiveFrom') ?? '').trim();
    input.effectiveFrom = from || null;
    const result = await save(input);
    if (result.ok) {
      setMessage(t('saved'));
      return router.refresh();
    }
    setMessage(result.error === 'LEGAL_BLOCK_TOO_LONG' ? t('tooLong') : t('invalid'));
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-6 grid max-w-3xl gap-4 sm:grid-cols-2"
      data-testid="company-form"
      noValidate
    >
      {FIELDS.map(([name, label]) => (
        <label key={name} className={name === 'address' ? 'block sm:col-span-2' : 'block'}>
          <span className="field-label">{t(label)}</span>
          <input
            name={name}
            required={!['phone', 'email', 'rib'].includes(name)}
            defaultValue={(current?.[name as keyof CompanyProfile] as string | null | undefined) ?? ''}
            dir={
              ['ice', 'ifNumber', 'rcNumber', 'patente', 'phone', 'email', 'rib'].includes(name)
                ? 'ltr'
                : undefined
            }
            className={INPUT}
            data-testid={`company-${name}`}
          />
        </label>
      ))}
      <label className="block">
        <span className="field-label">{t('effectiveFrom')}</span>
        <input name="effectiveFrom" type="date" dir="ltr" className={INPUT} data-testid="company-from" />
        <span className="field-hint block">{t('effectiveHint')}</span>
      </label>
      <div className="sm:col-span-2">
        <button type="submit" className="btn btn-primary" data-testid="company-save">
          {t('save')}
        </button>
        {message && (
          <p role="status" className="mt-2 text-sm" data-testid="company-message">
            {message}
          </p>
        )}
      </div>
    </form>
  );
}
