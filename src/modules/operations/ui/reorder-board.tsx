'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/ui';
import { countedToBase } from './count-form';

type Answer = { ok: true } | { ok: false; error: string };

export interface ReorderComponentOption {
  id: string;
  name: string;
  baseUnit: string;
}

/** Create form of the plant manager: the quantity is typed in kg or L and travels in base units. */
export function ReorderCreateForm({
  components,
  create,
}: {
  components: ReorderComponentOption[];
  create: (input: unknown) => Promise<Answer>;
}) {
  const t = useTranslations('operations.reorders');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const componentId = String(data.get('component') ?? '');
    const unit = components.find((c) => c.id === componentId)?.baseUnit ?? 'g';
    const qtyBase = countedToBase(String(data.get('qty') ?? ''), unit);
    if (qtyBase === null || qtyBase <= 0) return setMessage(t('errors.INVALID'));
    const r = await create({
      componentId,
      qtyBase,
      neededBy: String(data.get('neededBy') ?? ''),
      reason: String(data.get('reason') ?? ''),
    });
    if (r.ok) {
      setMessage(null);
      return router.refresh();
    }
    setMessage(t(`errors.${r.error}` as never));
  }

  return (
    <form
      onSubmit={submit}
      className="form-band mb-4 flex flex-wrap items-end gap-2"
      data-testid="reorder-form"
    >
      <label className="block">
        <span className="field-label">{t('component')}</span>
        <select name="component" required className="input mt-1" data-testid="reorder-component">
          {components.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="field-label">{t('qtyHint')}</span>
        <input
          name="qty"
          required
          inputMode="decimal"
          dir="ltr"
          className="input num mt-1 w-32"
          data-testid="reorder-qty"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('neededBy')}</span>
        <input
          name="neededBy"
          type="date"
          required
          dir="ltr"
          className="input mt-1"
          data-testid="reorder-needed"
        />
      </label>
      <label className="block">
        <span className="field-label">{t('reason')}</span>
        <input
          name="reason"
          required
          minLength={3}
          maxLength={400}
          className="input mt-1 w-64"
          data-testid="reorder-reason"
        />
      </label>
      <Button type="submit" small data-testid="reorder-save">
        {t('create')}
      </Button>
      {message && (
        <p role="alert" className="w-full text-sm font-semibold">
          {message}
        </p>
      )}
    </form>
  );
}

/** Row actions: mark seen, convert (link to an existing purchase code) for the purchasing roles; cancel with a reason for those who may. */
export function ReorderRowActions({
  id,
  state,
  canHandle,
  canCancel,
  seen,
  link,
  cancel,
}: {
  id: string;
  state: string;
  canHandle: boolean;
  canCancel: boolean;
  seen: (id: string) => Promise<Answer>;
  link: (id: string, code: string) => Promise<Answer>;
  cancel: (id: string, reason: string) => Promise<Answer>;
}) {
  const t = useTranslations('operations.reorders');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  if (state !== 'open' && state !== 'seen') return null;

  async function go(action: () => Promise<Answer>) {
    const r = await action();
    if (r.ok) {
      setMessage(null);
      return router.refresh();
    }
    setMessage(t(`errors.${r.error}` as never));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canHandle && state === 'open' && (
        <Button
          small
          variant="secondary"
          onClick={() => void go(() => seen(id))}
          data-testid={`reorder-seen-${id}`}
        >
          {t('markSeen')}
        </Button>
      )}
      {canHandle && (
        <>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ACH-2026-00001"
            dir="ltr"
            className="input w-40"
            aria-label={t('purchaseCode')}
            data-testid={`reorder-code-${id}`}
          />
          <Button small onClick={() => void go(() => link(id, code))} data-testid={`reorder-link-${id}`}>
            {t('convert')}
          </Button>
        </>
      )}
      {canCancel && (
        <>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="input w-40"
            aria-label={t('cancelReason')}
            data-testid={`reorder-cancel-reason-${id}`}
          />
          <Button
            small
            variant="secondary"
            onClick={() => void go(() => cancel(id, reason))}
            data-testid={`reorder-cancel-${id}`}
          >
            {t('cancel')}
          </Button>
        </>
      )}
      {message && (
        <p role="alert" className="w-full text-sm font-semibold">
          {message}
        </p>
      )}
    </div>
  );
}
