'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { ChecklistItem } from '../../domain/checklist';
import { StepUpDialog } from '../step-up-dialog';
import { type ChecklistActionResult, markChecklistItemAction } from './actions';
import { StatusPill } from '@/ui';

/** Owner view of the pre-real-data checklist: automated items are shown, manual ones marked with evidence. */
export function ChecklistPanel({ items, complete }: { items: ChecklistItem[]; complete: boolean }) {
  const t = useTranslations('checklist');
  const router = useRouter();
  const [retry, setRetry] = useState<(() => Promise<ChecklistActionResult>) | null>(null);
  const [message, setMessage] = useState<{ key: string; text: string } | null>(null);

  async function run(key: string, action: () => Promise<ChecklistActionResult>) {
    const result = await action();
    if (result.ok) {
      setMessage({ key, text: t('saved') });
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage({ key, text: result.message ?? t('error') });
  }

  function mark(key: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const evidence = String(new FormData(event.currentTarget).get('evidence') ?? '');
    void run(key, () => markChecklistItemAction(key, evidence));
  }

  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm">{complete ? t('complete') : t('intro')}</p>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.key} className="row-item" data-testid={`check-${item.key}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t(`items.${item.key}` as never)}</span>
              <StatusPill data-testid="status" status={item.status === 'done' ? 'paid' : 'neutral'}>
                {item.status === 'done' ? t('done') : t('open')}
              </StatusPill>
            </div>
            {item.kind === 'automated' && <p className="text-xs text-muted">{t('automated')}</p>}
            {item.evidence && item.kind !== 'automated' && (
              <p className="mt-1 text-sm text-ink">{item.evidence}</p>
            )}
            {item.kind !== 'automated' && item.status === 'open' && (
              <form onSubmit={(e) => mark(item.key, e)} className="mt-2 flex gap-2">
                <input name="evidence" required placeholder={t('evidence')} className="input flex-1" />
                <button type="submit" className="btn btn-primary btn-sm">
                  {item.kind === 'signoff' ? t('signoff') : t('mark')}
                </button>
              </form>
            )}
            {message?.key === item.key && (
              <p role="status" className="mt-1 text-sm" data-testid="check-message">
                {message.text}
              </p>
            )}
          </li>
        ))}
      </ul>
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
