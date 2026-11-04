'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button } from '@/ui';

type Result = { ok: true; value: string } | { ok: false; error: string };
type Input = { plantId: string; date: string; force: boolean; note?: string };

/** Closes the day of one plant. A forced close (owner or app_admin, with a note) asks for a fresh second factor first (F03). */
export function CloseDayForm({
  plantId,
  date,
  canForce,
  close,
}: {
  plantId: string;
  date: string;
  canForce: boolean;
  close: (input: Input) => Promise<Result>;
}) {
  const t = useTranslations('dayClose');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<Input | null>(null);

  async function run(input: Input) {
    const r = await close(input);
    if (!r.ok && r.error === 'STEP_UP_REQUIRED') return setRetry(input);
    if (!r.ok) return setMessage(t('error'));
    setMessage(r.value === 'blocked' ? t('blockedTold') : null);
    router.refresh();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    setMessage(null);
    void run({
      plantId,
      date,
      force: f.get('force') === 'on',
      ...(String(f.get('note') ?? '') ? { note: String(f.get('note')) } : {}),
    });
  }

  return (
    <div>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {canForce && (
          <>
            <label>
              <input type="checkbox" name="force" data-testid={`dayclose-force-${plantId}`} /> {t('force')}
            </label>
            <input name="note" placeholder={t('note')} />
          </>
        )}
        <Button type="submit" data-testid={`dayclose-close-${plantId}`}>
          {t('close')}
        </Button>
      </form>
      {message && (
        <p role="status" className="mt-1 text-sm" data-testid="dayclose-message">
          {message}
        </p>
      )}
      {retry && (
        <StepUpDialog
          onVerified={() => {
            const again = retry;
            setRetry(null);
            void run(again);
          }}
          onCancel={() => setRetry(null)}
        />
      )}
    </div>
  );
}
