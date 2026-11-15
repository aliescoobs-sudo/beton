'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';

type Answer = { ok: boolean; error?: string };

/** The other names of a client (the importer and the search use them) and how its orders are made: PO number mandatory, HT or TTC basis. */
export function ClientSalesPanel({
  clientId,
  aliases,
  terms,
  canEditTerms,
  addAlias,
  setTerms,
}: {
  clientId: string;
  aliases: string[];
  terms: { poRequired: boolean; priceBasis: 'HT' | 'TTC' };
  canEditTerms: boolean;
  addAlias: (input: unknown) => Promise<Answer>;
  setTerms: (input: unknown) => Promise<Answer>;
}) {
  const t = useTranslations('masterData.clients.sales');
  const [alias, setAlias] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  async function submitAlias(e: FormEvent) {
    e.preventDefault();
    const r = await addAlias({ clientId, alias });
    setMessage(r.ok ? t('aliasAdded') : t('refused'));
    if (r.ok) setAlias('');
  }
  async function submitTerms(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const r = await setTerms({
      clientId,
      poRequired: f.get('poRequired') === 'on',
      priceBasis: f.get('priceBasis'),
    });
    setMessage(r.ok ? t('termsSaved') : t('refused'));
  }
  return (
    <section aria-labelledby="client-sales" className="mt-8" data-testid="client-sales">
      <h2 id="client-sales" className="mb-3 text-xl">
        {t('title')}
      </h2>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2">{t('aliases')}</h3>
          {aliases.length === 0 ? (
            <p className="text-sm text-muted">{t('noAlias')}</p>
          ) : (
            <ul data-testid="client-aliases">
              {aliases.map((a) => (
                <li key={a} className="row-item text-sm">
                  <bdi>{a}</bdi>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={(e) => void submitAlias(e)} className="mt-3 flex items-end gap-2">
            <label className="block flex-1">
              <span className="field-label">{t('newAlias')}</span>
              <input
                className="input"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                minLength={2}
                maxLength={120}
                required
                data-testid="alias-input"
              />
            </label>
            <button type="submit" className="btn btn-secondary btn-sm" data-testid="alias-add">
              {t('add')}
            </button>
          </form>
        </div>
        <form
          onSubmit={(e) => void submitTerms(e)}
          className="form-band space-y-3"
          data-testid="client-terms"
        >
          <h3>{t('terms')}</h3>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="poRequired"
              defaultChecked={terms.poRequired}
              disabled={!canEditTerms}
            />
            <span>{t('poRequired')}</span>
          </label>
          <label className="block">
            <span className="field-label">{t('priceBasis')}</span>
            <select
              name="priceBasis"
              defaultValue={terms.priceBasis}
              disabled={!canEditTerms}
              className="input mt-1"
            >
              <option value="HT">HT</option>
              <option value="TTC">TTC</option>
            </select>
            <span className="field-hint">{t('priceBasisHint')}</span>
          </label>
          {canEditTerms && (
            <button type="submit" className="btn btn-primary btn-sm" data-testid="terms-save">
              {t('save')}
            </button>
          )}
        </form>
      </div>
      {message && (
        <p role="status" className="mt-2 text-sm" data-testid="client-sales-message">
          {message}
        </p>
      )}
    </section>
  );
}
