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

  function messageFor(error: Exclude<AdvanceActionResult, { ok: true }>['error']): string {
    switch (error) {
      case 'INVALID':
        return t('invalid');
      case 'NOT_FORWARD':
        return t('notForward');
      case 'TOO_FAR':
        return t('tooFar');
      case 'SIMULATION_DISABLED':
        return t('disabled');
      case 'SERVER_ERROR':
        return t('serverError');
      default:
        return t('error');
    }
  }

  async function run(call: () => Promise<AdvanceActionResult>) {
    const result = await call();
    if (result.ok) {
      setMessage(result.failedJob ? t('jobFailed', { job: result.failedJob }) : null);
      return router.refresh();
    }
    if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => call);
    setMessage(messageFor(result.error));
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
    <div className="space-y-3 text-sm" data-testid="advance-control">
      <button type="button" onClick={() => submit({ byDays: 1 })} className="btn btn-secondary btn-sm w-full">
        {t('oneDay')}
      </button>
      <form onSubmit={advanceTo} className="space-y-2">
        <label className="block">
          <span className="field-label">{t('to')}</span>
          <input name="date" type="date" required dir="ltr" className="input" />
        </label>
        <input name="time" type="time" required defaultValue="07:00" dir="ltr" className="input" />
        <button type="submit" className="btn btn-primary btn-sm w-full">
          {t('go')}
        </button>
      </form>
      {message && (
        <p role="alert" className="field-error">
          {message}
        </p>
      )}
      {retry && (
        <StepUp
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
