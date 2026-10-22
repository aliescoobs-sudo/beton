'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { BaseUnit } from '../../domain/component';
import {
  defaultEntryUnit,
  ENTRY_UNITS,
  formatEntryQty,
  magnitudeWarnings,
  parseEntryQty,
} from '../../domain/recette-units';
import { createRecetteVersionAction } from './actions';

export interface RecetteComponentView {
  id: string;
  nameFr: string;
  nameAr: string;
  baseUnit: BaseUnit;
}

export interface RecetteTypeView {
  id: string;
  code: string;
  label: string;
  versions: {
    id: string;
    version: number;
    effectiveFrom: string;
    lines: { componentId: string; qtyPerM3: number }[];
  }[];
}

const INPUT = 'mt-1 block rounded border border-gray-300 px-3 py-1';

/**
 * Per concrete type: the published versions (read-only, quantities per m³ in base units) and, for owner and
 * partner, a "new version" form pre-filled from the latest one. The server checks again on every write.
 */
export function RecettesManager({
  types,
  components,
  editable,
}: {
  types: RecetteTypeView[];
  components: RecetteComponentView[];
  editable: boolean;
}) {
  const t = useTranslations('masterData.recettes');
  const locale = useLocale();
  const router = useRouter();
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  // Quantities far from the previous version are published only after a second, explicit click.
  const [confirm, setConfirm] = useState<string | null>(null);
  const name = (c: RecetteComponentView) => (locale === 'ar' ? c.nameAr : c.nameFr);
  const byId = new Map(components.map((c) => [c.id, c]));

  async function submit(type: RecetteTypeView, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines: { componentId: string; qtyPerM3: number }[] = [];
    for (const c of components) {
      const raw = String(data.get(`qty-${c.id}`) ?? '').trim();
      if (raw === '') continue;
      const qty = parseEntryQty(
        raw,
        c.baseUnit,
        String(data.get(`unit-${c.id}`) ?? defaultEntryUnit(c.baseUnit)),
      );
      if (!qty.ok) return setMessage({ id: type.id, text: t('invalidQuantity', { name: name(c) }) });
      if (qty.value > 0) lines.push({ componentId: c.id, qtyPerM3: qty.value });
    }
    const odd = magnitudeWarnings(lines, type.versions[0]?.lines ?? []);
    if (odd.length > 0 && confirm !== type.id) {
      setConfirm(type.id);
      const names = odd
        .map((id) => (byId.get(id) ? name(byId.get(id) as RecetteComponentView) : id))
        .join(', ');
      return setMessage({ id: type.id, text: t('magnitudeWarning', { names }) });
    }
    setConfirm(null);
    const result = await createRecetteVersionAction(type.id, {
      effectiveFrom: String(data.get('effectiveFrom') ?? ''),
      lines,
    });
    if (result.ok) {
      setMessage({ id: type.id, text: t('saved') });
      return router.refresh();
    }
    const text =
      result.error === 'INVALID'
        ? t('invalid')
        : result.error === 'NOT_AFTER_LATEST'
          ? t('notAfterLatest')
          : result.error === 'INACTIVE_COMPONENT'
            ? t('inactiveComponent')
            : t('error');
    setMessage({ id: type.id, text });
  }

  return (
    <div className="mt-6 space-y-6">
      {!editable && <p className="text-sm text-gray-600">{t('readOnly')}</p>}
      {types.map((type) => {
        const latest = type.versions[0];
        const quantity = new Map(latest?.lines.map((l) => [l.componentId, l.qtyPerM3]));
        return (
          <section
            key={type.id}
            className="rounded border border-gray-200 p-3"
            data-testid={`recette-${type.code}`}
          >
            <h2 className="font-medium">
              <span dir="ltr">{type.code}</span> · <bdi>{type.label}</bdi>
            </h2>
            {type.versions.length === 0 && <p className="mt-2 text-sm text-gray-600">{t('none')}</p>}
            <ul className="mt-2 space-y-2">
              {type.versions.map((v) => (
                <li key={v.id} className="text-sm" data-testid={`recette-${type.code}-v${v.version}`}>
                  <p className="font-medium">
                    {t('version', { version: v.version })} · <span dir="ltr">{v.effectiveFrom}</span>
                  </p>
                  <ul className="ms-4 list-disc">
                    {v.lines.map((l) => {
                      const c = byId.get(l.componentId);
                      return (
                        <li key={l.componentId} dir="auto">
                          {c ? name(c) : l.componentId} :{' '}
                          <span dir="ltr">
                            {c
                              ? `${formatEntryQty(l.qtyPerM3, c.baseUnit, defaultEntryUnit(c.baseUnit))} ${defaultEntryUnit(c.baseUnit)}`
                              : l.qtyPerM3}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
            {editable && (
              <form
                onSubmit={(e) => void submit(type, e)}
                onChange={() => confirm === type.id && setConfirm(null)}
                className="mt-3 space-y-3"
                data-testid={`recette-new-${type.code}`}
              >
                <h3 className="text-sm font-medium">{t('newVersion')}</h3>
                <label className="block">
                  <span className="text-sm">{t('effectiveFrom')}</span>
                  <input name="effectiveFrom" type="date" required dir="ltr" className={INPUT} />
                </label>
                <div className="flex flex-wrap gap-3">
                  {components.map((c) => {
                    const previous = quantity.get(c.id);
                    const unit = defaultEntryUnit(c.baseUnit);
                    return (
                      <div key={c.id} className="block">
                        <label htmlFor={`qty-${type.code}-${c.id}`} className="text-sm">
                          {name(c)}
                        </label>
                        <div className="flex gap-1">
                          <input
                            id={`qty-${type.code}-${c.id}`}
                            name={`qty-${c.id}`}
                            inputMode="decimal"
                            defaultValue={
                              previous === undefined ? '' : formatEntryQty(previous, c.baseUnit, unit)
                            }
                            dir="ltr"
                            className={`${INPUT} w-28`}
                          />
                          {ENTRY_UNITS[c.baseUnit].length > 1 ? (
                            <select
                              name={`unit-${c.id}`}
                              defaultValue={unit}
                              dir="ltr"
                              aria-label={t('unitOf', { name: name(c) })}
                              className={INPUT}
                            >
                              {ENTRY_UNITS[c.baseUnit].map((u) => (
                                <option key={u.unit} value={u.unit}>
                                  {u.unit}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span dir="ltr" className="mt-1 py-1 text-sm">
                              {unit}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <button type="submit" className="rounded bg-gray-900 px-3 py-1 text-sm text-white">
                  {confirm === type.id ? t('publishAnyway') : t('publish')}
                </button>
                {message?.id === type.id && (
                  <p role="status" className="text-sm" data-testid="recette-message">
                    {message.text}
                  </p>
                )}
              </form>
            )}
          </section>
        );
      })}
    </div>
  );
}
