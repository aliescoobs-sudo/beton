'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type ComponentType, type FormEvent, useState } from 'react';
import type { AdvanceActionResult, AdvanceInput } from '../domain/advance-input';

interface StepUpProps {
  onVerified: () => void;
  onCancel: () => void;
}

/**
 * "Avancer à" control of the simulation badge. The server action (owner + step-up) and the step-up dialog come from
 * the app layer, which may depend on platform-security; `clock` does not.
 */
export function AdvanceControl({
  action,
  StepUp,
}: {
  action: (input: AdvanceInput) => Promise<AdvanceActionResult>;
  StepUp: ComponentType<StepUpProps>;
}) {
  const t = useTranslations('clock.advance');
  const router = useRouter();
  const [retry, setRetry] = useState<(() => Promise<AdvanceActionResult>) | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(call: () => Promise<AdvanceActionResult>) {
    const result = await call();
    if (result.ok) {
      setMessage(result.failedJob ? t('jobFailed', { job: result.failedJob }) : null);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => call);
    setMessage(result.error === 'INVALID' ? t('invalid') : t('error'));
  }

  function submit(input: AdvanceInput) {
    setMessage(null);
    void run(() => action(input));
  }

  function advanceTo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit({ toDate: String(data.get('date') ?? ''), toTime: String(data.get('time') ?? '') });
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2 text-sm" data-testid="advance-control">
      <button type="button" onClick={() => submit({ byDays: 1 })} className="rounded bg-white/20 px-2 py-0.5">
        {t('oneDay')}
      </button>
      <form onSubmit={advanceTo} className="flex items-center gap-1">
        <label className="flex items-center gap-1">
          <span>{t('to')}</span>
          <input name="date" type="date" required dir="ltr" className="rounded px-1 text-gray-900" />
        </label>
        <input
          name="time"
          type="time"
          required
          defaultValue="07:00"
          dir="ltr"
          className="rounded px-1 text-gray-900"
        />
        <button type="submit" className="rounded bg-white/20 px-2 py-0.5">
          {t('go')}
        </button>
      </form>
      {message && <span role="alert">{message}</span>}
      {retry && (
        <StepUp
          onVerified={() => {
            const again = retry;
            setRetry(null);
            void again().then((r) => (r.ok ? router.refresh() : setMessage(t('error'))));
          }}
          onCancel={() => setRetry(null)}
        />
      )}
    </div>
  );
}
