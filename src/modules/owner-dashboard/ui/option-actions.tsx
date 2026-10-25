'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button } from '@/ui';

export interface ApplyInput {
  alertKey: string;
  optionId: string;
  accountId?: string;
  expectedGainCentimes?: number;
  locale: string;
}
export type ApplyResult = { ok: true; draftText: string; deposited: number } | { ok: false; error: string };

/**
 * "Préparer" opens the confirmation (what will happen, the bank account for a deposit, the draft message); "Confirmer"
 * applies the option after a fresh second factor. Nothing is sent: the draft is for the owner to copy.
 */
export function OptionActions({
  alertKey,
  optionId,
  expectedGain,
  banks,
  draftPreview,
  presentsPostDated,
  apply,
  locale,
  testId,
}: {
  alertKey: string;
  optionId: string;
  expectedGain?: number;
  /** Bank accounts to deposit to: only for an option that deposits cheques. */
  banks: { id: string; label: string }[] | null;
  draftPreview: string;
  presentsPostDated: boolean;
  apply: (input: ApplyInput) => Promise<ApplyResult>;
  locale: string;
  testId: string;
}) {
  const t = useTranslations('dashboard.option');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState<(ApplyResult & { ok: true }) | null>(null);
  const [copied, setCopied] = useState(false);
  const [retry, setRetry] = useState<(() => Promise<ApplyResult>) | null>(null);
  const [account, setAccount] = useState(banks?.[0]?.id ?? '');

  async function run(action: () => Promise<ApplyResult>) {
    setPending(true);
    setMessage(null);
    try {
      const result = await action();
      if (result.ok) {
        // No refresh here: an option that solves the problem makes the alert disappear, and the owner still needs the
        // draft message in front of him. The page is fresh when he goes back.
        setDone(result);
        return;
      }
      if (result.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
      const known = [
        'STALE',
        'NOT_FOUND',
        'ACCOUNT_REQUIRED',
        'ILLEGAL_TRANSITION',
        'INVALID',
        'FORBIDDEN',
        'UNAUTHENTICATED',
        'REENROL_REQUIRED',
      ];
      setMessage(t(`errors.${known.includes(result.error) ? result.error : 'other'}` as never));
    } finally {
      setPending(false);
    }
  }

  const confirm = () =>
    run(() =>
      apply({
        alertKey,
        optionId,
        locale,
        ...(banks ? { accountId: account } : {}),
        ...(expectedGain !== undefined ? { expectedGainCentimes: expectedGain } : {}),
      }),
    );

  if (done)
    return (
      <div className="space-y-2" data-testid={`${testId}-done`}>
        <p role="status" className="font-semibold">
          {t('applied')}
          {done.deposited > 0 && ` · ${done.deposited} ${t('deposited')}`}
        </p>
        {done.draftText && (
          <DraftBox
            label={t('draft')}
            text={done.draftText}
            copy={t('copy')}
            copied={t('copied')}
            state={[copied, setCopied]}
          />
        )}
      </div>
    );

  return (
    <div className="space-y-3">
      {!open ? (
        <Button onClick={() => setOpen(true)} data-testid={`${testId}-prepare`}>
          {t('prepare')}
        </Button>
      ) : (
        <div className="form-band space-y-3" data-testid={`${testId}-panel`}>
          <p className="text-sm text-muted">{t('confirmHint')}</p>
          {presentsPostDated && <p className="text-sm font-semibold">{t('postDated')}</p>}
          {banks && (
            <label className="block">
              <span className="field-label">{t('account')}</span>
              <select
                className="input mt-1"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                data-testid={`${testId}-account`}
              >
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draftPreview && (
            <DraftBox
              label={t('draft')}
              text={draftPreview}
              copy={t('copy')}
              copied={t('copied')}
              state={[copied, setCopied]}
            />
          )}
          <div className="flex gap-2">
            <Button
              disabled={pending || (banks !== null && account === '')}
              onClick={() => void confirm()}
              data-testid={`${testId}-confirm`}
            >
              {pending ? t('preparing') : t('confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
          {message && (
            <p role="alert" className="text-sm font-semibold" data-testid={`${testId}-error`}>
              {message}
            </p>
          )}
        </div>
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

function DraftBox({
  label,
  text,
  copy,
  copied,
  state: [isCopied, setCopied],
}: {
  label: string;
  text: string;
  copy: string;
  copied: string;
  state: [boolean, (v: boolean) => void];
}) {
  return (
    <div className="space-y-1">
      <p className="field-label">{label}</p>
      <pre className="whitespace-pre-wrap border border-rule bg-surface p-3 text-sm" data-testid="draft-text">
        {text}
      </pre>
      <Button
        variant="secondary"
        small
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
        }}
      >
        {isCopied ? copied : copy}
      </Button>
    </div>
  );
}
