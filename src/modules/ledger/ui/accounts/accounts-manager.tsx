'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { negateCentimes, parseCentimes } from '@/lib/money';
import { AddButton, CancelButton, Notice, type Message } from '@/modules/master-data/ui/read-mode';
import { Money, Table, Th } from '@/ui';
import type { MoneyAccount } from '../../service/money-account-service';

type Result = { ok: true } | { ok: false; error: string };

/** The caisse and the bank accounts with their opening balance. Owner edits; support reads (the server checks again). */
export function AccountsManager({
  accounts,
  editable,
  createAction,
  openingAction,
}: {
  accounts: MoneyAccount[];
  editable: boolean;
  createAction: (input: unknown) => Promise<Result>;
  openingAction: (input: unknown) => Promise<Result>;
}) {
  const t = useTranslations('ledger.accounts');
  const router = useRouter();
  const [message, setMessage] = useState<Message | null>(null);
  // 'new' = the add form, an account id = that account's opening balance form.
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<'cash' | 'bank'>('cash');

  async function done(id: string, result: Result) {
    if (result.ok) {
      setMessage({ id, text: t('saved'), ok: true });
      setOpen(null);
      return router.refresh();
    }
    const text =
      result.error === 'DUPLICATE' ? t('duplicate') : result.error === 'INVALID' ? t('invalid') : t('error');
    setMessage({ id, text, ok: false });
  }

  async function createSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await done(
      'new',
      await createAction({
        kind,
        label: String(data.get('label') ?? ''),
        bankName: kind === 'bank' ? String(data.get('bankName') ?? '') : null,
      }),
    );
  }

  async function openingSubmit(accountId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const raw = String(data.get('amount') ?? '').trim();
    const negative = raw.startsWith('-');
    const parsed = parseCentimes(negative ? raw.slice(1) : raw);
    if (parsed === null) return setMessage({ id: accountId, text: t('invalid'), ok: false });
    await done(
      accountId,
      await openingAction({
        accountId,
        asOf: String(data.get('asOf') ?? ''),
        amountCentimes: negative ? negateCentimes(parsed) : parsed,
        note: String(data.get('note') ?? '').trim() || null,
      }),
    );
  }

  return (
    <div className="mt-6 space-y-4">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      <Notice message={message} testId="account-message" />
      {editable &&
        (open === 'new' ? (
          <form
            onSubmit={(e) => void createSubmit(e)}
            className="form-band flex flex-wrap items-end gap-3"
            data-testid="account-new"
          >
            <label className="block">
              <span className="field-label">{t('kind')}</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value === 'bank' ? 'bank' : 'cash')}
                className="input mt-1"
                data-testid="account-kind"
              >
                <option value="cash">{t('cash')}</option>
                <option value="bank">{t('bank')}</option>
              </select>
            </label>
            <label className="block">
              <span className="field-label">{t('label')}</span>
              <input name="label" maxLength={80} required className="input mt-1 w-56" />
            </label>
            {kind === 'bank' && (
              <label className="block">
                <span className="field-label">{t('bankName')}</span>
                <input name="bankName" maxLength={80} required className="input mt-1 w-56" />
              </label>
            )}
            <button type="submit" className="btn btn-primary btn-sm">
              {t('add')}
            </button>
            <CancelButton onClick={() => setOpen(null)} />
            <Notice message={message} id="new" testId="account-message" />
          </form>
        ) : (
          <AddButton label={t('add')} onClick={() => setOpen('new')} testId="account-add" />
        ))}
      {accounts.length === 0 ? (
        <p className="text-sm text-muted" data-testid="accounts-empty">
          {t('empty')}
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t('label')}</Th>
              <Th>{t('kind')}</Th>
              <Th>{t('bankName')}</Th>
              <Th>{t('asOf')}</Th>
              <Th numeric>{t('opening')}</Th>
              {editable && <Th>{t('actions')}</Th>}
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} data-testid={`account-${a.label}`}>
                <td className="font-medium">
                  <bdi>{a.label}</bdi>
                </td>
                <td>{t(a.kind)}</td>
                <td>{a.bankName ? <bdi>{a.bankName}</bdi> : '—'}</td>
                <td>{a.opening ? <bdi dir="ltr">{a.opening.asOf}</bdi> : '—'}</td>
                <td className="is-num">
                  {a.opening ? (
                    <span data-testid="account-opening">
                      <Money centimes={a.opening.amountCentimes} />
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                {editable && (
                  <td>
                    {a.opening ? null : open === a.id ? (
                      <form
                        onSubmit={(e) => void openingSubmit(a.id, e)}
                        className="flex flex-wrap items-end gap-2 py-2"
                      >
                        <label className="block">
                          <span className="field-label">{t('asOf')}</span>
                          <input name="asOf" type="date" required dir="ltr" className="input mt-1" />
                        </label>
                        <label className="block">
                          <span className="field-label">{t('amount')}</span>
                          <input
                            name="amount"
                            required
                            dir="ltr"
                            inputMode="decimal"
                            className="input mt-1 w-36"
                            data-testid="account-amount"
                          />
                        </label>
                        <label className="block">
                          <span className="field-label">{t('note')}</span>
                          <input name="note" maxLength={500} className="input mt-1 w-48" />
                        </label>
                        <button
                          type="submit"
                          className="btn btn-primary btn-sm"
                          data-testid="account-opening-save"
                        >
                          {t('save')}
                        </button>
                        <CancelButton onClick={() => setOpen(null)} />
                        <Notice message={message} id={a.id} testId="account-message" />
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setOpen(a.id)}
                        data-testid="account-set-opening"
                      >
                        {t('setOpening')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
