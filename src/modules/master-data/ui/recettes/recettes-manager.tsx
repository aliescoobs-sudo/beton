'use client';

import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { createRecetteVersionAction } from './actions';

export interface RecetteComponentView {
  id: string;
  nameFr: string;
  nameAr: string;
  baseUnit: string;
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
  const name = (c: RecetteComponentView) => (locale === 'ar' ? c.nameAr : c.nameFr);
  const byId = new Map(components.map((c) => [c.id, c]));

  async function submit(type: RecetteTypeView, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const lines = components
      .map((c) => ({ componentId: c.id, raw: String(data.get(`qty-${c.id}`) ?? '').trim() }))
      .filter((l) => l.raw !== '' && Number(l.raw) !== 0)
      .map((l) => ({ componentId: l.componentId, qtyPerM3: Number(l.raw) }));
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
              <span dir="ltr">{type.code}</span> · {type.label}
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
                            {l.qtyPerM3} {c?.baseUnit}
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
                className="mt-3 space-y-3"
                data-testid={`recette-new-${type.code}`}
              >
                <h3 className="text-sm font-medium">{t('newVersion')}</h3>
                <label className="block">
                  <span className="text-sm">{t('effectiveFrom')}</span>
                  <input name="effectiveFrom" type="date" required dir="ltr" className={INPUT} />
                </label>
                <div className="flex flex-wrap gap-3">
                  {components.map((c) => (
                    <label key={c.id} className="block">
                      <span className="text-sm">
                        {name(c)} (<span dir="ltr">{c.baseUnit}</span>)
                      </span>
                      <input
                        name={`qty-${c.id}`}
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={quantity.get(c.id) ?? ''}
                        dir="ltr"
                        className={`${INPUT} w-32`}
                      />
                    </label>
                  ))}
                </div>
                <button type="submit" className="rounded bg-gray-900 px-3 py-1 text-sm text-white">
                  {t('publish')}
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
