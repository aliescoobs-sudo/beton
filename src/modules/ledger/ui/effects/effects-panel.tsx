import { useLocale, useTranslations } from 'next-intl';
import { formatCentimes } from '@/lib/money';
import type { Effect } from '../../domain/effects';

const n = (value: number, max = 1) =>
  value.toLocaleString('fr-FR', { maximumFractionDigits: max }).replace(/[  ]/g, ' ');

/** A stock quantity in its base unit (g, mL, L) as kg or L. */
function qty(base: number, unit: string): string {
  const big = unit === 'g' || unit === 'mL';
  return `${n(big ? base / 1000 : base)} ${unit === 'g' ? 'kg' : 'L'}`;
}

/**
 * "What did this change?" after a recorded action (ledger L35): the typed facts the service returned, already filtered
 * for the role that did it. The panel only words them; it never adds or computes anything.
 */
export function EffectsPanel({
  effects,
  testId = 'effects',
}: {
  effects: readonly Effect[];
  testId?: string;
}) {
  const t = useTranslations('effects');
  const locale = useLocale();
  if (effects.length === 0) return null;
  return (
    <section
      aria-label={t('title')}
      data-testid={testId}
      className="mt-3 rounded border border-rule bg-band p-3 text-sm"
    >
      <h3 className="mb-1 font-bold">{t('title')}</h3>
      <ul className="space-y-1">
        {effects.map((e, i) => (
          <li key={i} data-effect={e.kind}>
            {e.kind === 'document' && (
              <>
                {t(`documents.${e.document}`)} <bdi dir="ltr">{e.code}</bdi>
              </>
            )}
            {e.kind === 'scheduled' && (
              <>
                {t('scheduled')} <bdi dir="ltr">{e.date}</bdi>
              </>
            )}
            {e.kind === 'remaining' && (
              <>
                {t('remaining', { code: e.orderCode })} <bdi dir="ltr">{n(e.remainingL / 1000, 3)} m³</bdi>
              </>
            )}
            {e.kind === 'stock' && (
              <>
                {locale === 'ar' ? e.componentNameAr : e.componentNameFr} :{' '}
                <bdi dir="ltr">
                  {e.deltaBase > 0 ? '+' : '−'}
                  {qty(Math.abs(e.deltaBase), e.baseUnit)} → {qty(e.levelAfter, e.baseUnit)}
                </bdi>{' '}
                <span data-status={e.status}>({t(`stockStatus.${e.status}`)})</span>
              </>
            )}
            {e.kind === 'receivable' && (
              <>
                {e.amountCentimes < 0 ? t('receivableDown') : t('receivableUp')}
                {e.clientCode ? ` ${e.clientCode}` : ''} :{' '}
                <bdi dir="ltr">
                  {e.amountCentimes > 0 ? '+' : ''}
                  {formatCentimes(e.amountCentimes)} MAD
                </bdi>
              </>
            )}
            {e.kind === 'payable' && (
              <>
                {t('payableUp')}
                {e.supplierCode ? ` ${e.supplierCode}` : ''} :{' '}
                <bdi dir="ltr">+{formatCentimes(e.amountCentimes)} MAD</bdi>
              </>
            )}
            {(e.kind === 'payment_in' || e.kind === 'payment_out') && (
              <>
                {e.kind === 'payment_in' ? t('paymentIn') : t('paymentOut')} ({t(`methods.${e.method}`)}) :{' '}
                <bdi dir="ltr">{formatCentimes(e.amountCentimes)} MAD</bdi> —{' '}
                {e.cleared ? t('cleared') : t('pending')}
              </>
            )}
            {e.kind === 'payable_covered' && (
              <>
                {t('payableCovered', { code: e.purchaseCode })}{' '}
                <bdi dir="ltr">{formatCentimes(e.amountCentimes)} MAD</bdi>
              </>
            )}
            {e.kind === 'receivable_spread' && (
              <>
                {t('spread')} <bdi dir="ltr">{formatCentimes(e.amountCentimes)} MAD</bdi>
              </>
            )}
            {e.kind === 'receivable_covered' && (
              <>
                {t('covered', { code: e.orderCode })}{' '}
                <bdi dir="ltr">{formatCentimes(e.amountCentimes)} MAD</bdi>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
