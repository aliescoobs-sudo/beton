import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { getCompanyProfile, getRelatedDocuments, legalMentions } from '@/modules/ledger';
import { RelatedDocuments } from '@/modules/ledger/ui/related/related-documents';
import { getDeliveryNote } from '@/modules/operations';
import { formatM3 } from '@/modules/operations/ui/format';
import { PrintNoteButton } from '@/modules/operations/ui/print-note-button';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import { printNoteAction } from './actions';

/** The delivery note (bon de livraison): who, where, what, which truck, signature boxes. No price or payment. */
export default async function DeliveryNotePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'deliveries.read');
  const note = await getDeliveryNote(getPool('app'), user, id);
  if (!note) notFound();
  const company = await getCompanyProfile(getPool('app'), user, { today: (await getRequestClock()).today() });
  const t = await getTranslations('operations.note');
  const related = await getRelatedDocuments(getPool('app'), user, { kind: 'bl', id });
  const rows: [string, React.ReactNode][] = [
    [
      t('client'),
      <bdi key="c" dir="ltr">
        {[note.clientCode, note.clientName].filter(Boolean).join(' · ')}
      </bdi>,
    ],
    [t('site'), [note.siteLabel, note.zoneName].filter(Boolean).join(' · ') || '—'],
    [
      t('order'),
      <bdi key="o" dir="ltr">
        {note.orderCode}
      </bdi>,
    ],
    [t('type'), <bdi key="t" dir="ltr">{`${note.typeCode} · ${note.typeLabel}`}</bdi>],
    [t('volume'), <bdi key="v" dir="ltr">{`${formatM3(Math.abs(note.volumeL))} m³`}</bdi>],
    [t('truck'), <bdi key="k" dir="ltr">{`${note.truckCode} · ${note.truckPlate}`}</bdi>],
    [
      t('loadedAt'),
      <bdi key="l" dir="ltr">
        {note.loadedAt.slice(0, 16).replace('T', ' ')} UTC
      </bdi>,
    ],
  ];
  return (
    <div>
      <PageHeader
        title={
          <>
            {t('title')} <bdi dir="ltr">{note.blNo}</bdi>
          </>
        }
        actions={
          <span className="no-print flex gap-2">
            <PrintNoteButton deliveryId={id} audit={printNoteAction} />
            <a
              href={`/${locale}/deliveries/${id}/pdf`}
              className="btn btn-secondary btn-sm"
              data-testid="pdf-download"
            >
              {(await getTranslations('ledger.pdf'))('download')}
            </a>
          </span>
        }
      />
      <article className="card max-w-3xl space-y-6 p-6" data-testid="delivery-note">
        {company ? (
          <div className="text-sm" data-testid="note-company">
            {legalMentions(company).map((line) => (
              <p key={line}>
                <bdi dir="ltr">{line}</bdi>
              </p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{t('company')}</p>
        )}
        {note.cancelled && (
          <p role="status" className="font-bold text-danger" data-testid="note-cancelled">
            {t('cancelled')}
          </p>
        )}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="font-bold">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="grid grid-cols-2 gap-6 pt-10">
          <div className="border-t border-ink pt-2 text-sm">{t('signDriver')}</div>
          <div className="border-t border-ink pt-2 text-sm">{t('signClient')}</div>
        </div>
      </article>
      <RelatedDocuments items={related} locale={locale} className="mt-8" />
    </div>
  );
}
