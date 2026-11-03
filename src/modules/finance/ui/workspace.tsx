'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Field, Input, Select, Money } from '@/ui';
import { addMonths } from '../domain/period';
import { financeAmount } from '../domain/input';
import { steelFlows } from '../domain/forecast';
import { subtract } from '../domain/money';
import type { getFinanceReport, getFinanceCash } from '../service/report-service';
import type { getFinanceReferences } from '../service/reference-service';
import { financeLabels } from './labels';
type Labels = (typeof financeLabels)['fr'] | (typeof financeLabels)['ar'];
type Report = Awaited<ReturnType<typeof getFinanceReport>>;
type Cash = Awaited<ReturnType<typeof getFinanceCash>>;
type References = Awaited<ReturnType<typeof getFinanceReferences>>;
const val = (d: FormData, k: string) => String(d.get(k) ?? '');
const optional = (d: FormData, k: string) => val(d, k) || undefined;
function Form({
  id,
  title,
  l,
  children,
  build,
  endpoint = '/api/finance',
  onResult,
}: {
  id: string;
  title: string;
  l: Labels;
  children: ReactNode;
  build: (d: FormData) => unknown;
  endpoint?: string;
  onResult?: (r: unknown) => void;
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [pending, setPending] = useState<unknown>(null),
    [code, setCode] = useState('');
  async function send(input: unknown) {
    setBusy(true);
    setMessage('');
    try {
      const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
        body = await r.json();
      if (body.error === 'STEP_UP_REQUIRED') {
        setPending(input);
        return;
      }
      if (!r.ok) throw new Error();
      setPending(null);
      setMessage((input as { action?: string })?.action === 'simulateSteel' ? l.simulate : l.saved);
      onResult?.(body);
      router.refresh();
    } catch {
      setMessage(l.refused);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      void send(build(new FormData(e.currentTarget)));
    } catch {
      setMessage(l.refused);
    }
  }
  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetch('/api/auth/two-factor/verify-totp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) throw new Error();
      await send(pending);
    } catch {
      setMessage(l.refused);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="border border-rule bg-surface p-4">
      <summary className="cursor-pointer font-semibold">{title}</summary>
      <form data-testid={id} onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2">
        {children}
        <Button type="submit" disabled={busy}>
          {l.confirm}
        </Button>
      </form>
      {message && (
        <p role="status" className="mt-3">
          {message}
        </p>
      )}
      {pending !== null && (
        <form onSubmit={verify} className="mt-4 space-y-3">
          <p>{l.stepUp}</p>
          <Field label={l.code}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {l.verify}
          </Button>
          <Button onClick={() => setPending(null)} variant="secondary">
            {l.cancel}
          </Button>
        </form>
      )}
    </details>
  );
}
const MoneyField = ({ name, label }: { name: string; label: string }) => (
  <Field label={label}>
    <Input name={name} inputMode="decimal" required dir="ltr" placeholder="0,00" />
  </Field>
);
const TextField = ({ name, label, required = true }: { name: string; label: string; required?: boolean }) => (
  <Field label={label}>
    <Input name={name} required={required} maxLength={160} />
  </Field>
);
const DateField = ({ name, label, value }: { name: string; label: string; value: string }) => (
  <Field label={label}>
    <Input type="date" name={name} defaultValue={value} required />
  </Field>
);
const Picker = ({
  name,
  label,
  options,
  empty,
}: {
  name: string;
  label: string;
  options: { id: string; label: string }[];
  empty?: string;
}) => (
  <Field label={label}>
    <Select name={name} required={!empty}>
      {empty && <option value="">{empty}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </Select>
  </Field>
);
export function FinanceWorkspace({
  report,
  cash,
  refs,
  plants,
  locale,
  today,
}: {
  report: Report;
  cash: Cash;
  refs: References;
  plants: { id: string; name: string }[];
  locale: 'fr' | 'ar';
  today: string;
}) {
  const l = financeLabels[locale],
    [tab, setTab] = useState('report'),
    [scheduleCount, setScheduleCount] = useState(3),
    [simulation, setSimulation] = useState<{
      suggested: boolean;
      costCentimes: number;
      horizonTo: string;
      scenario: { minimumCentimes: number };
      differenceToBankCentimes: number;
    } | null>(null);
  const tabs = ['report', 'cash', 'entries', 'loans', 'steel', 'materials', 'settings'] as const;
  const accounts = cash.accounts.map((a) => ({ id: a.id, label: a.label }));
  const obligations = refs.obligations.map((o) => ({ id: o.id, label: `${o.label} — ${o.due_date}` }));
  const ref = <TextField name="reference" label={l.reference} />;
  const date = <DateField name="date" label={l.date} value={today} />;
  const account = <Picker name="accountId" label={l.account} options={accounts} />;
  const allocation = (
    <Picker name="allocationId" label={l.allocation} options={refs.allocations} empty={l.none} />
  );
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2" aria-label={l.title}>
        {tabs.map((t) => (
          <Button
            key={t}
            variant={tab === t ? 'primary' : 'secondary'}
            onClick={() => setTab(t)}
            data-testid={`finance-tab-${t}`}
            aria-pressed={tab === t}
          >
            {l[t]}
          </Button>
        ))}
      </nav>
      {tab === 'report' && (
        <section className="space-y-4" data-testid="finance-report">
          <h2 className="text-xl font-semibold">{report.title}</h2>
          {!report.complete && (
            <Card>
              <p role="alert">{l.incomplete}</p>
              <p>
                {l.missing}: {report.missingValuations}
              </p>
              <p>
                {l.excluded} ({report.excludedRevenueCount}):{' '}
                <Money centimes={report.excludedRevenueCentimes} />
              </p>
            </Card>
          )}
          <p>
            {l.leasing}: {report.leasingTreatment === 'expense' ? l.expensePolicy : l.interestPolicy}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-start">
              <thead>
                <tr>
                  {[l.plant, l.revenue, l.cost, l.result, l.principal].map((s) => (
                    <th key={s} className="p-3 text-start">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ...report.plants,
                  { ...report.central, label: l.central },
                  { ...report.total, label: l.total },
                ].map((r, i) => (
                  <tr key={i} className="border-t border-rule">
                    <th className="p-3 text-start">{r.label}</th>
                    {[r.revenueCentimes, r.costsCentimes, r.resultCentimes, r.principalCentimes].map(
                      (n, j) => (
                        <td key={j} className="p-3">
                          <Money centimes={n} />
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <a
            className="btn btn-secondary"
            href={`/${locale}/finance/export?from=${report.from}&to=${report.to}`}
          >
            {l.export}
          </a>
        </section>
      )}
      {tab === 'cash' && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">{l.cash}</h2>
          <p>
            {l.opening}: <Money centimes={cash.openingCentimes} />
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {cash.accounts.map((a) => (
              <Card key={a.id}>
                <strong>{a.label}</strong>
                <p>{l[a.holder as 'owner'] ?? a.holder}</p>
                <Money centimes={a.balanceCentimes} />
              </Card>
            ))}
          </div>
          <Card>
            <p>
              {l.scheduled}: {l.minimum} <Money centimes={cash.scheduled.minimumCentimes} />
            </p>
            <p>
              {l.conservative}: <Money centimes={cash.conservative.minimumCentimes} />
            </p>
          </Card>
          {cash.scheduled.shortageDays.length > 0 && (
            <p role="alert">
              {l.warning}: {cash.scheduled.shortageDays[0]!.date}
            </p>
          )}
          <div className="max-h-80 overflow-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th>{l.date}</th>
                  <th>{l.scheduled}</th>
                </tr>
              </thead>
              <tbody>
                {cash.scheduled.days.map((d) => (
                  <tr key={d.date}>
                    <td>{d.date}</td>
                    <td>
                      <Money centimes={d.balanceCentimes} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Form
            id="finance-payment"
            title={l.payment}
            l={l}
            build={(d) => ({
              action: 'payment',
              obligationId: val(d, 'obligationId'),
              date: val(d, 'date'),
              amountCentimes: financeAmount(val(d, 'amount')),
              accountId: val(d, 'accountId'),
              instrumentId: optional(d, 'instrumentId'),
              reference: val(d, 'reference'),
            })}
          >
            <Picker name="obligationId" label={l.obligation} options={obligations} />
            {date}
            <MoneyField name="amount" label={l.amount} />
            {account}
            <Picker name="instrumentId" label={l.instrument} options={refs.instruments} empty={l.none} />
            {ref}
          </Form>
          <Form
            id="finance-link"
            title={l.link}
            l={l}
            build={(d) => ({
              action: 'link',
              obligationId: val(d, 'obligationId'),
              instrumentId: val(d, 'instrumentId'),
            })}
          >
            <Picker name="obligationId" label={l.obligation} options={obligations} />
            <Picker name="instrumentId" label={l.instrument} options={refs.instruments} />
          </Form>
          <Form
            id="finance-transfer"
            title={l.transfer}
            l={l}
            build={(d) => ({
              action: 'transfer',
              fromAccountId: val(d, 'fromAccountId'),
              toAccountId: val(d, 'toAccountId'),
              date: val(d, 'date'),
              amountCentimes: financeAmount(val(d, 'amount')),
              reference: val(d, 'reference'),
            })}
          >
            <Picker name="fromAccountId" label={l.fromAccount} options={accounts} />
            <Picker name="toAccountId" label={l.toAccount} options={accounts} />
            {date}
            <MoneyField name="amount" label={l.amount} />
            {ref}
          </Form>
          <Form
            id="finance-holder"
            title={l.holder}
            l={l}
            build={(d) => ({ action: 'holder', accountId: val(d, 'accountId'), holder: val(d, 'holder') })}
          >
            {account}
            <Picker
              name="holder"
              label={l.holder}
              options={['owner', 'office', 'company_bank'].map((id) => ({ id, label: l[id as 'owner'] }))}
            />
          </Form>
        </section>
      )}
      {tab === 'entries' && (
        <section className="space-y-4">
          <Form
            id="finance-entry"
            title={l.entries}
            l={l}
            build={(d) => ({
              action: 'entry',
              recurrenceMonths: Number(val(d, 'recurrenceMonths') || 1),
              date: val(d, 'date'),
              dueDate: val(d, 'dueDate'),
              kind: val(d, 'kind'),
              amountCentimes: financeAmount(val(d, 'amount')),
              categoryId: optional(d, 'categoryId'),
              plantId: optional(d, 'plantId'),
              allocationId: optional(d, 'allocationId'),
              reference: val(d, 'reference'),
            })}
          >
            {date}
            <DateField name="dueDate" label={l.due} value={today} />
            <Picker
              name="kind"
              label={l.kind}
              options={[
                { id: 'expense', label: l.expense },
                { id: 'pumping', label: l.pumping },
              ]}
            />
            <MoneyField name="amount" label={l.amount} />
            <Picker name="categoryId" label={l.category} options={refs.categories} empty={l.none} />
            <Picker
              name="plantId"
              label={l.plant}
              options={plants.map((p) => ({ id: p.id, label: p.name }))}
              empty={l.unassigned}
            />
            {allocation}
            {ref}
            <Field label={l.months}>
              <Input name="recurrenceMonths" type="number" min={1} max={120} defaultValue={1} required />
            </Field>
          </Form>
          <Form
            id="finance-reverse"
            title={l.reverse}
            l={l}
            build={(d) => ({
              action: 'reverse',
              entryId: val(d, 'entryId'),
              date: val(d, 'date'),
              reason: val(d, 'reason'),
            })}
          >
            <Picker
              name="entryId"
              label={l.entry}
              options={refs.entries.map((e) => ({ id: e.id, label: `${e.entry_date} — ${e.source_ref}` }))}
            />
            {date}
            <TextField name="reason" label={l.reason} />
          </Form>
          <ul className="space-y-2">
            {refs.entries.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-2 border-b border-rule py-2">
                <span>
                  {e.entry_date} · {e.source_ref}
                </span>
                <Money centimes={Number(e.amount_centimes)} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {tab === 'loans' && (
        <Form
          id="finance-facility"
          title={l.loans}
          l={l}
          build={(d) => ({
            action: 'facility',
            plantId: optional(d, 'plantId'),
            allocationId: optional(d, 'allocationId'),
            kind: val(d, 'kind'),
            label: val(d, 'label'),
            date: val(d, 'date'),
            principalCentimes: financeAmount(val(d, 'capital')),
            accountId: val(d, 'accountId'),
            schedule: Array.from({ length: scheduleCount }, (_, i) => ({
              date: val(d, `due${i}`),
              principalCentimes: financeAmount(val(d, `capital${i}`)),
              costCentimes: financeAmount(val(d, `cost${i}`)),
            })),
          })}
        >
          <Picker
            name="kind"
            label={l.kind}
            options={[
              { id: 'bank', label: l.bank },
              { id: 'leasing', label: l.leasingKind },
            ]}
          />
          <TextField name="label" label={l.label} />
          {date}
          <MoneyField name="capital" label={l.capital} />
          {account}
          <Picker
            name="plantId"
            label={l.plant}
            options={plants.map((p) => ({ id: p.id, label: p.name }))}
            empty={l.unassigned}
          />
          {allocation}
          <Field label={l.months}>
            <Input
              type="number"
              min={1}
              max={120}
              value={scheduleCount}
              onChange={(e) => setScheduleCount(Math.max(1, Math.min(120, Number(e.target.value) || 1)))}
            />
          </Field>
          {Array.from({ length: scheduleCount }, (_, i) => (
            <fieldset
              key={i}
              className="col-span-full grid gap-3 rounded border border-rule p-3 sm:grid-cols-3"
            >
              <legend>
                {l.due} {i + 1}
              </legend>
              <DateField name={`due${i}`} label={l.date} value={addMonths(today, i + 1)} />
              <MoneyField name={`capital${i}`} label={l.capital} />
              <MoneyField name={`cost${i}`} label={l.interest} />
            </fieldset>
          ))}
        </Form>
      )}
      {tab === 'steel' && (
        <section className="space-y-4">
          <p>{l.steelNote}</p>
          <Form
            id="finance-steel"
            title={l.steel}
            l={l}
            build={(d) => ({
              action: 'steel',
              date: val(d, 'date'),
              cashCentimes: financeAmount(val(d, 'cash')),
              purchaseCentimes: financeAmount(val(d, 'purchase')),
              chequeCount: Number(val(d, 'cheques')),
              accountId: val(d, 'accountId'),
              reference: val(d, 'reference'),
            })}
          >
            {date}
            <MoneyField name="cash" label={l.steelCash} />
            <MoneyField name="purchase" label={l.steelPurchase} />
            <Field label={l.cheques}>
              <Input name="cheques" type="number" min={1} max={3} defaultValue={3} required />
            </Field>
            <Picker
              name="accountId"
              label={l.account}
              options={cash.accounts
                .filter((a) => a.kind === 'cash')
                .map((a) => ({ id: a.id, label: a.label }))}
            />
            {ref}
          </Form>
          <Form
            id="finance-steel-simulation"
            title={l.simulate}
            l={l}
            onResult={(r) => setSimulation(r as typeof simulation)}
            build={(d) => ({
              action: 'simulateSteel',
              from: today,
              to: addMonths(today, 4),
              bankCostCentimes: financeAmount(val(d, 'bankCost')),
              deals: Array.from({ length: Number(val(d, 'count')) }, () => ({
                deliveryDate: today,
                cashCentimes: financeAmount(val(d, 'cash')),
                purchaseCentimes: financeAmount(val(d, 'purchase')),
                chequeCount: 3,
              })),
            })}
          >
            <MoneyField name="cash" label={l.steelCash} />
            <MoneyField name="purchase" label={l.steelPurchase} />
            <MoneyField name="bankCost" label={l.bankCost} />
            <Field label={l.dealCount}>
              <Input name="count" type="number" min={1} max={12} defaultValue={1} required />
            </Field>
          </Form>
          {simulation && (
            <Card>
              <p role="status">{simulation.suggested ? l.proposed : l.notProposed}</p>
              <p>
                {l.steelCost}: <Money centimes={simulation.costCentimes} />
              </p>
              <p>
                {l.minimum}: <Money centimes={simulation.scenario.minimumCentimes} />
              </p>
              <p>
                {l.horizon}: {simulation.horizonTo}
              </p>
              <p>
                {l.bankCost}:{' '}
                <Money centimes={subtract(simulation.costCentimes, simulation.differenceToBankCentimes)} />
              </p>
            </Card>
          )}
          {refs.steel.map((s) => (
            <Card key={s.id}>
              <strong>{s.reference}</strong>
              <p>
                {s.delivery_date}: <Money centimes={Number(s.cash_centimes)} />
              </p>
              <p>
                {l.steelCost}:{' '}
                <Money centimes={subtract(Number(s.purchase_centimes), Number(s.cash_centimes))} />
              </p>
              {steelFlows({
                deliveryDate: s.delivery_date,
                cashCentimes: Number(s.cash_centimes),
                purchaseCentimes: Number(s.purchase_centimes),
                chequeCount: s.cheque_count,
              })
                .slice(1)
                .map((f, i) => (
                  <p key={i}>
                    {f.date}: <Money centimes={f.amountCentimes} />
                  </p>
                ))}
            </Card>
          ))}
        </section>
      )}
      {tab === 'materials' && (
        <section className="space-y-4">
          <Form
            id="finance-material"
            title={l.materials}
            l={l}
            build={(d) => ({
              action: 'valueMaterial',
              movementId: val(d, 'movementId'),
              priceCentimes: financeAmount(val(d, 'price')),
              priceBaseQty: Number(val(d, 'baseQty')),
              reference: val(d, 'reference'),
            })}
          >
            <Picker
              name="movementId"
              label={l.movement}
              options={refs.materials.map((m) => ({
                id: m.id,
                label: `${m.date} · ${m.componentName ?? m.componentId} · ${-m.qtyBase} ${m.baseUnit ?? ''}`,
              }))}
            />
            <MoneyField name="price" label={l.unitPrice} />
            <Field label={l.baseQty}>
              <Input name="baseQty" type="number" min={1} step={1} required />
            </Field>
            <TextField name="reference" label={l.evidence} />
          </Form>
          <Form
            id="finance-fuel"
            title={locale === 'fr' ? 'Coût du carburant consommé' : 'تكلفة الكازوال المستهلك'}
            l={l}
            build={(d) => ({
              action: 'valueFuel',
              fillId: val(d, 'fillId'),
              pricePerLitreCentimes: financeAmount(val(d, 'price')),
              allocationId: optional(d, 'allocationId'),
              reference: val(d, 'reference'),
            })}
          >
            <Picker
              name="fillId"
              label={l.movement}
              options={refs.fuel.map((f) => ({
                id: f.id,
                label: `${f.date} · ${f.truck} · ${f.qtyMl / 1000} L`,
              }))}
            />
            <MoneyField
              name="price"
              label={locale === 'fr' ? 'Coût documenté par litre (MAD)' : 'التكلفة الموثقة للتر بالدرهم'}
            />
            {allocation}
            <TextField name="reference" label={l.evidence} />
          </Form>
        </section>
      )}

      {tab === 'settings' && (
        <section className="space-y-4">
          <Form
            id="finance-category"
            title={l.category}
            l={l}
            build={(d) => ({
              action: 'category',
              code: val(d, 'code'),
              label: val(d, 'label'),
              nature: val(d, 'nature'),
              kind: val(d, 'kind'),
            })}
          >
            <TextField name="code" label={l.reference} />
            <TextField name="label" label={l.label} />
            <Picker
              name="nature"
              label={l.kind}
              options={[
                { id: 'fixed', label: l.fixed },
                { id: 'variable', label: l.variable },
              ]}
            />
            <Picker
              name="kind"
              label={l.kind}
              options={[
                { id: 'expense', label: l.expense },
                { id: 'pumping', label: l.pumping },
              ]}
            />
          </Form>
          <Form
            id="finance-allocation"
            title={l.allocation}
            l={l}
            build={(d) => ({
              action: 'allocation',
              label: val(d, 'label'),
              weights: Object.fromEntries(plants.map((p) => [p.id, Number(val(d, p.id))])),
            })}
          >
            <TextField name="label" label={l.label} />
            {plants.map((p) => (
              <Field key={p.id} label={`${p.name} — ${l.weight}`}>
                <Input name={p.id} type="number" min={0} step={1} defaultValue={1} required />
              </Field>
            ))}
          </Form>
          <Form
            id="finance-policy"
            title={l.leasing}
            l={l}
            endpoint="/api/finance-configuration"
            build={(d) => ({
              action: 'configure',
              enabled: true,
              leasingTreatment: val(d, 'leasingTreatment'),
            })}
          >
            <Picker
              name="leasingTreatment"
              label={l.leasing}
              options={[
                { id: 'expense', label: l.expensePolicy },
                { id: 'principal_interest', label: l.interestPolicy },
              ]}
            />
          </Form>
        </section>
      )}
    </div>
  );
}
