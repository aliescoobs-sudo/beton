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
import { Table, Th } from '@/ui';
import { AddButton, CancelButton, type Message, Notice } from '../read-mode';
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
    plantId: string | null;
    effectiveFrom: string;
    lines: { componentId: string; qtyPerM3: number }[];
  }[];
}

const INPUT = 'input mt-1';

/**
 * Per concrete type: the published versions (read-only, quantities per m³ in base units) and, for owner and
 * partner, a "new version" form pre-filled from the latest one. The server checks again on every write.
 */
export function RecettesManager({
  types,
  components,
  plants,
  editable,
}: {
  types: RecetteTypeView[];
  components: RecetteComponentView[];
  plants: { id: string; name: string }[];
  editable: boolean;
}) {
  const t = useTranslations('masterData.recettes');
  const locale = useLocale();
  const router = useRouter();
  const [message, setMessage] = useState<Message | null>(null);
  // The type whose "new version" form is open; null = read mode.
  const [open, setOpen] = useState<string | null>(null);
  // Quantities far from the previous version are published only after a second, explicit click.
  const [confirm, setConfirm] = useState<string | null>(null);
  const name = (c: RecetteComponentView) => (locale === 'ar' ? c.nameAr : c.nameFr);
  const byId = new Map(components.map((c) => [c.id, c]));
  // The scope of a mix: null is all plants; a plant's own mix wins for that plant.
  const scopeName = (plantId: string | null) =>
    plantId === null ? t('allPlants') : (plants.find((p) => p.id === plantId)?.name ?? plantId);

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
      if (!qty.ok)
        return setMessage({ id: type.id, ok: false, text: t('invalidQuantity', { name: name(c) }) });
      if (qty.value > 0) lines.push({ componentId: c.id, qtyPerM3: qty.value });
    }
    const scope = String(data.get('plantId') ?? '') || null;
    const odd = magnitudeWarnings(lines, type.versions.find((v) => v.plantId === scope)?.lines ?? []);
    if (odd.length > 0 && confirm !== type.id) {
      setConfirm(type.id);
      const names = odd
        .map((id) => (byId.get(id) ? name(byId.get(id) as RecetteComponentView) : id))
        .join(', ');
      return setMessage({ id: type.id, ok: false, text: t('magnitudeWarning', { names }) });
    }
    setConfirm(null);
    const result = await createRecetteVersionAction(type.id, {
      plantId: scope,
      effectiveFrom: String(data.get('effectiveFrom') ?? ''),
      lines,
    });
    if (result.ok) {
      setMessage({ id: type.id, ok: true, text: t('saved') });
      setOpen(null);
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
    setMessage({ id: type.id, ok: false, text });
  }

  /** Quantities of one version: component, quantity per m³ with its fixed unit as a suffix. */
  const versionTable = (lines: { componentId: string; qtyPerM3: number }[]) => (
    <div className="max-w-md">
      <Table>
        <thead>
          <tr>
            <Th>{t('component')}</Th>
            <Th numeric>{t('qtyPerM3')}</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const c = byId.get(l.componentId);
            const unit = c ? defaultEntryUnit(c.baseUnit) : '';
            return (
              <tr key={l.componentId}>
                <td dir="auto">{c ? name(c) : l.componentId}</td>
                <td className="is-num">
                  <bdi dir="ltr">
                    {c ? `${formatEntryQty(l.qtyPerM3, c.baseUnit, unit)} ${unit}` : l.qtyPerM3}
                  </bdi>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );

  return (
    <div className="mt-6 space-y-6">
      {!editable && <p className="text-sm text-muted">{t('readOnly')}</p>}
      {types.map((type) => {
        // One block per scope (all plants, then each plant with its own mix); versions arrive newest first.
        const scopes: (string | null)[] = [];
        for (const v of type.versions) if (!scopes.includes(v.plantId)) scopes.push(v.plantId);
        scopes.sort((a, b) => (a === null ? -1 : b === null ? 1 : scopeName(a).localeCompare(scopeName(b))));
        const quantity = new Map(
          type.versions.find((v) => v.plantId === null)?.lines.map((l) => [l.componentId, l.qtyPerM3]),
        );
        // Seeded labels repeat the code ("Béton B12" for B12): show the code only when the label lacks it.
        const title = type.label.includes(type.code) ? type.label : `${type.code} ${type.label}`;
        return (
          <section key={type.id} className="row-item" data-testid={`recette-${type.code}`}>
            <h2 className="text-xl">
              <bdi>{title}</bdi>
            </h2>
            {scopes.length === 0 && <p className="mt-2 text-sm text-muted">{t('none')}</p>}
            {scopes.map((scope) => {
              const [latest, ...older] = type.versions.filter((v) => v.plantId === scope);
              if (!latest) return null;
              const key = scope ?? 'all';
              return (
                <div key={key} className="mt-3" data-testid={`recette-${type.code}-scope-${key}`}>
                  <h3 className="text-sm font-semibold" data-testid={`recette-${type.code}-scope-name`}>
                    <bdi>{scopeName(scope)}</bdi>
                  </h3>
                  <div
                    className="mt-1 space-y-2"
                    data-testid={`recette-${type.code}-${key}-v${latest.version}`}
                  >
                    <p className="flex flex-wrap gap-x-4 text-sm font-medium">
                      <span>{t('version', { version: latest.version })}</span>
                      <span dir="ltr" className="num">
                        {latest.effectiveFrom}
                      </span>
                    </p>
                    {versionTable(latest.lines)}
                  </div>
                  {older.length > 0 && (
                    <details className="mt-3 text-sm">
                      <summary>{t('olderVersions', { count: older.length })}</summary>
                      <ul className="mt-2 space-y-3">
                        {older.map((v) => (
                          <li key={v.id} data-testid={`recette-${type.code}-${key}-v${v.version}`}>
                            <p className="flex flex-wrap gap-x-4 font-medium">
                              <span>{t('version', { version: v.version })}</span>
                              <span dir="ltr" className="num">
                                {v.effectiveFrom}
                              </span>
                            </p>
                            {versionTable(v.lines)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              );
            })}
            <Notice message={message?.id === type.id ? message : null} testId="recette-message" />
            {editable &&
              (open === type.id ? (
                <form
                  onSubmit={(e) => void submit(type, e)}
                  onChange={() => confirm === type.id && setConfirm(null)}
                  className="form-band mt-3 space-y-3"
                  data-testid={`recette-new-${type.code}`}
                >
                  <h3 className="text-sm font-semibold">{t('newVersion')}</h3>
                  {plants.length > 1 && (
                    <label className="block">
                      <span className="text-sm">{t('plantScope')}</span>
                      <select name="plantId" defaultValue="" className={INPUT} data-testid="recette-plant">
                        <option value="">{t('allPlants')}</option>
                        {plants.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
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
                          <div className="mt-1 flex items-stretch">
                            <input
                              id={`qty-${type.code}-${c.id}`}
                              name={`qty-${c.id}`}
                              inputMode="decimal"
                              defaultValue={
                                previous === undefined ? '' : formatEntryQty(previous, c.baseUnit, unit)
                              }
                              dir="ltr"
                              className="input w-28 rounded-e-none"
                            />
                            {ENTRY_UNITS[c.baseUnit].length > 1 ? (
                              <select
                                name={`unit-${c.id}`}
                                defaultValue={unit}
                                dir="ltr"
                                aria-label={t('unitOf', { name: name(c) })}
                                className="input w-auto rounded-s-none border-s-0 bg-band"
                              >
                                {ENTRY_UNITS[c.baseUnit].map((u) => (
                                  <option key={u.unit} value={u.unit}>
                                    {u.unit}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span
                                dir="ltr"
                                className="grid min-w-10 place-items-center border border-s-0 border-field bg-band px-2 text-sm"
                              >
                                {unit}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-3">
                    <button type="submit" className="btn btn-primary btn-sm">
                      {confirm === type.id ? t('publishAnyway') : t('publish')}
                    </button>
                    <CancelButton
                      onClick={() => {
                        setOpen(null);
                        setConfirm(null);
                      }}
                    />
                  </div>
                  <Notice message={message} id={type.id} testId="recette-message" />
                </form>
              ) : (
                <div className="mt-3">
                  <AddButton
                    label={t('newVersionButton')}
                    onClick={() => setOpen(type.id)}
                    testId={`recette-open-${type.code}`}
                  />
                </div>
              ))}
          </section>
        );
      })}
    </div>
  );
}
