'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { type ClientActionResult } from './actions';

export interface ClientFormValues {
  name: string;
  kind: 'company' | 'person';
  ice: string;
  phone: string;
  contactName: string;
  defaultZoneId: string;
  paymentTermsDays: number;
  notes: string;
}

export const EMPTY_CLIENT: ClientFormValues = {
  name: '',
  kind: 'company',
  ice: '',
  phone: '',
  contactName: '',
  defaultZoneId: '',
  paymentTermsDays: 60,
  notes: '',
};

const input = 'mt-1 block w-full rounded border border-gray-300 px-3 py-1';

/**
 * Name and kind are all a new client needs; the rest sits under "more details". A second client on an existing ICE
 * is blocked with a pointer to the existing one; owner/partner (`canOverride`) can accept it with a reason.
 */
export function ClientForm({
  initial,
  zones,
  submitLabel,
  canOverride,
  onSubmit,
  onSaved,
  testId,
}: {
  initial: ClientFormValues;
  zones: { id: string; name: string }[];
  submitLabel: string;
  canOverride: boolean;
  onSubmit: (input: unknown) => Promise<ClientActionResult>;
  onSaved?: () => void;
  testId: string;
}) {
  const t = useTranslations('masterData.clients');
  const router = useRouter();
  const [kind, setKind] = useState(initial.kind);
  const [message, setMessage] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ code: string; name: string } | null>(null);
  const [needsReason, setNeedsReason] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? '');
    const result = await onSubmit({
      name: text('name'),
      kind,
      ice: kind === 'company' ? text('ice') : '',
      phone: text('phone'),
      contactName: text('contactName'),
      defaultZoneId: text('defaultZoneId'),
      paymentTermsDays: text('paymentTermsDays') === '' ? undefined : Number(text('paymentTermsDays')),
      notes: text('notes'),
      iceOverrideReason: text('iceOverrideReason'),
    });
    setExisting(null);
    if (result.ok) {
      setNeedsReason(false);
      setMessage(
        result.similar.length > 0 ? t('savedSimilar', { name: result.similar[0]!.name }) : t('saved'),
      );
      if (initial.name === '') form.reset();
      onSaved?.();
      return router.refresh();
    }
    if (result.error === 'DUPLICATE_ICE') {
      setNeedsReason(canOverride);
      if (result.existing) setExisting({ code: result.existing.code, name: result.existing.name });
      setMessage(canOverride ? t('duplicateIceOverride') : t('duplicateIce'));
      return;
    }
    setMessage(result.error === 'INVALID' ? t('invalid') : t('error'));
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3" data-testid={testId}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-sm font-medium">{t('name')}</span>
          <input
            name="name"
            defaultValue={initial.name}
            maxLength={120}
            required
            className={`${input} w-64`}
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium">{t('kind')}</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as ClientFormValues['kind'])}
            className={`${input} w-40`}
          >
            <option value="company">{t('kindCompany')}</option>
            <option value="person">{t('kindPerson')}</option>
          </select>
        </label>
        <button type="submit" className="rounded bg-gray-900 px-3 py-1 text-sm text-white">
          {submitLabel}
        </button>
      </div>
      <details open={initial.name !== ''}>
        <summary className="cursor-pointer text-sm">{t('moreDetails')}</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {kind === 'company' && (
            <label className="block">
              <span className="text-sm font-medium">{t('ice')}</span>
              <input name="ice" defaultValue={initial.ice} inputMode="numeric" dir="ltr" className={input} />
            </label>
          )}
          <label className="block">
            <span className="text-sm font-medium">{t('phone')}</span>
            <input name="phone" defaultValue={initial.phone} type="tel" dir="ltr" className={input} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">{t('contactName')}</span>
            <input name="contactName" defaultValue={initial.contactName} maxLength={120} className={input} />
          </label>
          <label className="block">
            <span className="text-sm font-medium">{t('defaultZone')}</span>
            <select name="defaultZoneId" defaultValue={initial.defaultZoneId} className={input}>
              <option value="">—</option>
              {zones.map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {zone.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium">{t('paymentTerms')}</span>
            <input
              name="paymentTermsDays"
              type="number"
              min={0}
              max={120}
              defaultValue={initial.paymentTermsDays}
              dir="ltr"
              className={input}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-sm font-medium">{t('notes')}</span>
            <textarea name="notes" defaultValue={initial.notes} maxLength={2000} rows={2} className={input} />
          </label>
          {needsReason && (
            <label className="block sm:col-span-2">
              <span className="text-sm font-medium">{t('iceOverrideReason')}</span>
              <input name="iceOverrideReason" minLength={3} maxLength={500} required className={input} />
            </label>
          )}
        </div>
      </details>
      {message && (
        <p role="status" className="text-sm" data-testid="client-message">
          {message}
          {existing && (
            <span data-testid="client-existing">
              {' '}
              <span dir="ltr">{existing.code}</span> — {existing.name}
            </span>
          )}
        </p>
      )}
    </form>
  );
}
