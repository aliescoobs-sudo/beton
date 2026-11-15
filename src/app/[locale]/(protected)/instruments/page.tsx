import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getRequestClock } from '@/app/request-clock';
import { getPool } from '@/lib/db/pools';
import { daysBetween, listInstruments, listMoneyAccounts, listOpenInvoices } from '@/modules/ledger';
import { DepositBatch } from '@/modules/ledger/ui/instruments/deposit-batch';
import { InstrumentActions } from '@/modules/ledger/ui/instruments/instrument-actions';
import { InstrumentAllocate } from '@/modules/ledger/ui/instruments/instrument-allocate';
import { InstrumentsTable } from '@/modules/ledger/ui/instruments/instruments-table';
import { can, recordMoneyView } from '@/modules/platform-security';
import { requireAnyPagePermission } from '@/modules/platform-security/next';
import { PageHeader } from '@/ui';
import {
  allocateToInvoiceAction,
  bounceAction,
  cancelAction,
  clearAction,
  depositAction,
  disputeAction,
  regularizeAction,
} from './actions';

/** The instruments with their state, early and post-dated badges and the regularization countdown. Owner and support. */
export default async function InstrumentsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requireAnyPagePermission(locale, [
    'instruments.read',
    'instruments.read_in',
    'instruments.read_out',
  ]);
  const pool = getPool('app');
  await recordMoneyView(pool, user, 'screen:instruments');
  const editable = can(user.role, 'instruments.manage');
  const [instruments, clock, accounts, openInvoices] = await Promise.all([
    listInstruments(pool, user),
    getRequestClock(),
    editable ? listMoneyAccounts(pool, user) : Promise.resolve([]),
    editable ? listOpenInvoices(pool, user) : Promise.resolve([]),
  ]);
  const today = clock.today();
  const t = await getTranslations('ledger.instruments');
  const usedAsCover = new Set(
    instruments.flatMap((i) => i.events.map((e) => e.coveringInstrumentId).filter(Boolean)),
  );
  const accountOptions = accounts.map((a) => ({ id: a.id, label: a.label, kind: a.kind }));
  const actions = {
    deposit: depositAction,
    clear: clearAction,
    bounce: bounceAction,
    regularize: regularizeAction,
    dispute: disputeAction,
    cancel: cancelAction,
  };

  return (
    <div>
      <PageHeader title={t('title')} />
      {editable && (
        <DepositBatch
          today={today}
          banks={accountOptions.filter((a) => a.kind === 'bank')}
          deposit={depositAction}
          items={instruments
            .filter(
              (i) =>
                i.direction === 'in' &&
                i.state === 'received' &&
                (i.method === 'cheque' || i.method === 'lcn'),
            )
            .map((i) => ({
              id: i.id,
              label: i.number ?? i.id,
              amountCentimes: i.amountCentimes,
              writtenDate: i.writtenDate,
            }))}
        />
      )}
      <InstrumentsTable
        today={today}
        rows={instruments.map((i) => {
          const bounced = i.events.find((e) => e.event === 'bounced');
          return {
            ...i,
            daysLeft:
              i.state === 'bounced' && bounced?.regularizationDeadline
                ? daysBetween(today, bounced.regularizationDeadline)
                : null,
            deadline: bounced?.regularizationDeadline ?? null,
            earlyEvent: i.events.some((e) => e.early),
          };
        })}
        actions={
          editable
            ? (row) => (
                <>
                  <InstrumentAllocate
                    row={row}
                    allocate={allocateToInvoiceAction}
                    invoices={openInvoices.map((i) => ({
                      id: i.invoiceId,
                      number: i.number,
                      dueDate: i.dueDate,
                      openCentimes: i.openCentimes,
                      clientId: i.clientId,
                    }))}
                  />
                  <InstrumentActions
                    row={row}
                    today={today}
                    accounts={accountOptions}
                    actions={actions}
                    covers={instruments
                      .filter(
                        (c) =>
                          row.state === 'bounced' &&
                          c.direction === 'in' &&
                          c.partyId === row.partyId &&
                          c.id !== row.id &&
                          c.amountCentimes >= row.amountCentimes &&
                          ['received', 'deposited', 'cleared'].includes(c.state) &&
                          !usedAsCover.has(c.id),
                      )
                      .map((c) => ({ id: c.id, label: `${c.number ?? c.method} · ${c.receivedDate}` }))}
                  />
                </>
              )
            : undefined
        }
      />
    </div>
  );
}
