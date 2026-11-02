'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { StepUpDialog } from '@/modules/platform-security/ui/step-up-dialog';
import { Button, StatusPill, Table, Td, Th } from '@/ui';
import type { FieldAccount } from '../service/auth';

type Result = { ok: true } | { ok: false; error: string };

/** Drivers and pump operators: their account, PIN and bound phone. A second factor is asked for each change. */
export function FieldAdmin({
  accounts,
  actions,
}: {
  accounts: FieldAccount[];
  actions: {
    create: (driverId: string) => Promise<Result>;
    setPin: (input: { driverId: string; pin: string }) => Promise<Result>;
    revoke: (driverId: string) => Promise<Result>;
  };
}) {
  const t = useTranslations('field.admin');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => Promise<Result>) | null>(null);

  async function run(action: () => Promise<Result>) {
    setMessage(null);
    const r = await action();
    if (r.ok) {
      setMessage(t('done'));
      return router.refresh();
    }
    if (r.error === 'STEP_UP_REQUIRED') return setRetry(() => action);
    setMessage(r.error === 'TOO_EASY' ? t('tooEasy') : r.error === 'INVALID' ? t('invalidPin') : t('error'));
  }

  return (
    <div className="mt-6 space-y-4" data-testid="field-admin">
      {message && (
        <p role="status" className="text-sm" data-testid="field-admin-message">
          {message}
        </p>
      )}
      <Table data-testid="field-accounts">
        <thead>
          <tr>
            <Th>{t('driver')}</Th>
            <Th>{t('kind')}</Th>
            <Th>{t('account')}</Th>
            <Th>{t('pin')}</Th>
            <Th>{t('phone')}</Th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.driverId} data-testid={`field-account-${a.code}`}>
              <Td>
                <bdi dir="ltr">{a.code}</bdi> {a.name}
              </Td>
              <Td>{t(`kinds.${a.kind}`)}</Td>
              <Td>
                {a.hasAccount ? (
                  <StatusPill status="paid">{t('yes')}</StatusPill>
                ) : (
                  <Button
                    type="button"
                    small
                    onClick={() => void run(() => actions.create(a.driverId))}
                    data-testid={`field-create-${a.code}`}
                  >
                    {t('create')}
                  </Button>
                )}
              </Td>
              <Td>
                {a.hasAccount && (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const form = e.currentTarget;
                      const pin = String(new FormData(form).get('pin') ?? '');
                      void run(() => actions.setPin({ driverId: a.driverId, pin })).then(() => form.reset());
                    }}
                  >
                    <input
                      name="pin"
                      type="password"
                      inputMode="numeric"
                      maxLength={6}
                      dir="ltr"
                      className="input num w-24"
                      aria-label={t('pin')}
                      data-testid={`field-pin-${a.code}`}
                    />
                    <Button type="submit" small variant="secondary" data-testid={`field-pin-save-${a.code}`}>
                      {a.hasPin ? t('reset') : t('set')}
                    </Button>
                    {a.lockedUntil && <StatusPill status="late">{t('locked')}</StatusPill>}
                  </form>
                )}
              </Td>
              <Td>
                {a.deviceBoundAt ? (
                  <span className="flex items-center gap-2">
                    <span className="text-sm">{t('bound')}</span>
                    <Button
                      type="button"
                      small
                      variant="secondary"
                      onClick={() => void run(() => actions.revoke(a.driverId))}
                      data-testid={`field-revoke-${a.code}`}
                    >
                      {t('release')}
                    </Button>
                  </span>
                ) : (
                  '—'
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
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
