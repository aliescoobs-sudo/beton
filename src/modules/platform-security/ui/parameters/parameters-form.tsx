'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { parameterLabelKey } from '../../domain/parameters';
import { StepUpDialog } from '../step-up-dialog';
import { type ParameterActionResult, setParameterAction } from './actions';

export interface ParameterRow {
  key: string;
  value: number | string;
  kind: 'number' | 'time';
  min?: number;
  max?: number;
}

/** Owner edits (each save is a sensitive action); the partner sees the same values read-only. */
export function ParametersForm({ rows, editable }: { rows: ParameterRow[]; editable: boolean }) {
  const t = useTranslations('parameters');
  const router = useRouter();
  const [retry, setRetry] = useState<(() => Promise<ParameterActionResult>) | null>(null);
  const [message, setMessage] = useState<{ key: string; text: string } | null>(null);

  async function run(key: string, action: () => Promise<ParameterActionResult>) {
    const result = await action();
    if (result.ok) {
      setMessage({ key, text: t('saved') });
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage({ key, text: result.error === 'INVALID' ? t('invalid') : t('error') });
  }

  function save(row: ParameterRow, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const raw = String(new FormData(event.currentTarget).get('value') ?? '');
    const value = row.kind === 'number' ? Number(raw) : raw;
    setMessage(null);
    void run(row.key, () => setParameterAction(row.key, value));
  }

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-gray-600">{t('readOnly')}</p>}
      {rows.map((row) => (
        <form
          key={row.key}
          onSubmit={(e) => save(row, e)}
          className="rounded border border-gray-200 p-3"
          data-testid={`param-${row.key}`}
        >
          <label className="block">
            <span className="text-sm font-medium">{t(`keys.${parameterLabelKey(row.key)}` as never)}</span>
            {editable ? (
              <input
                name="value"
                defaultValue={row.value}
                type={row.kind === 'number' ? 'number' : 'time'}
                min={row.min}
                max={row.max}
                dir="ltr"
                className="mt-1 block w-40 rounded border border-gray-300 px-3 py-1"
              />
            ) : (
              <span className="mt-1 block font-mono" dir="ltr" data-testid="value">
                {row.value}
              </span>
            )}
          </label>
          {row.min !== undefined && (
            <p className="mt-1 text-xs text-gray-500">{t('bounds', { min: row.min, max: row.max ?? '' })}</p>
          )}
          {editable && (
            <button type="submit" className="mt-2 rounded bg-gray-900 px-3 py-1 text-sm text-white">
              {t('save')}
            </button>
          )}
          {message?.key === row.key && (
            <p role="status" className="mt-1 text-sm" data-testid="param-message">
              {message.text}
            </p>
          )}
        </form>
      ))}
      {retry && (
        <StepUpDialog
          onVerified={() => {
            const again = retry;
            setRetry(null);
            void again().then(() => router.refresh());
          }}
          onCancel={() => setRetry(null)}
        />
      )}
    </div>
  );
}
