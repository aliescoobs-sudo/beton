import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getPool } from '@/lib/db/pools';
import { getEnv } from '@/lib/server-env';
import {
  getInvoiceTiming,
  listMyDocumentRequests,
  listPendingDocumentRequests,
  type MyDocumentRequest,
  type PendingDocumentRequest,
} from '@/modules/ledger';
import { DocumentRequestsBoard } from '@/modules/ledger/ui/document-requests-board';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import {
  decideDocumentRequestAction,
  requestDocumentAction,
  setInvoiceSequenceAction,
  setInvoiceTimingAction,
  releaseDocumentRequestAction,
} from './actions';

/** The gate for documents a client asked for, the timing of the final invoice and the invoice numbering (R7, §9). */
export default async function DocumentRequestsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!getEnv().DOCUMENTS_V1_ENABLED) notFound();
  const user = await requirePagePermission(locale, 'documents.read');
  const pool = getPool('app');
  const mine: MyDocumentRequest[] = can(user.role, 'documents.request')
    ? await listMyDocumentRequests(pool, user)
    : [];
  const pending: PendingDocumentRequest[] = can(user.role, 'approvals.read')
    ? await listPendingDocumentRequests(pool, user)
    : [];
  const timing = await getInvoiceTiming(pool, user);
  const t = await getTranslations('documentRequests');
  return (
    <div>
      <PageHeader title={t('title')} description={t('intro')} />
      <DocumentRequestsBoard
        mine={mine}
        pending={pending}
        timing={timing}
        canRequest={can(user.role, 'documents.request')}
        canDecide={can(user.role, 'documents.decide')}
        canSetTiming={can(user.role, 'documents.policy')}
        canSetSequence={can(user.role, 'documents.sequence')}
        actions={{
          request: requestDocumentAction,
          use: releaseDocumentRequestAction,
          decide: decideDocumentRequestAction,
          setTiming: setInvoiceTimingAction,
          setSequence: setInvoiceSequenceAction,
        }}
      />
    </div>
  );
}
