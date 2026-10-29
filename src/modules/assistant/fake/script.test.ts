import { describe, expect, it } from 'vitest';
import type { LlmMessage, LlmRequest } from '@/lib/ai/llm-provider';
import { prepareForModel, toDataBlock } from '../domain/data-block';
import { allowedFrom, checkNumbers } from '../domain/numbers-check';
import { Pseudonymizer } from '../domain/pseudonymizer';
import { isPlainText } from '../domain/display';
import { fakeScript } from './script';

// What each tool returns (the shapes of the tool schemas), as the model reads it after pseudonymization.
const RESULTS: Record<string, unknown> = {
  deliveries_today: {
    date: '2026-10-26',
    count: 2,
    rotations: [
      {
        truck: 'T1',
        loadTime: '07:00',
        arriveTime: '07:40',
        m3: 7.5,
        client: 'CLT-001',
        product: 'B25',
        step: 'loaded',
        bl: 'BL-2026-00012',
      },
      {
        truck: 'T2',
        loadTime: '08:30',
        arriveTime: '09:10',
        m3: 6,
        client: null,
        product: null,
        step: 'planned',
        bl: null,
      },
    ],
  },
  next_load: {
    found: true,
    rotation: {
      truck: 'T2',
      loadTime: '08:30',
      arriveTime: '09:10',
      m3: 6,
      client: 'CLT-002',
      product: 'B20',
      step: 'planned',
      bl: null,
    },
  },
  stock_and_cover: {
    count: 2,
    components: [
      {
        nameFr: 'Ciment',
        nameAr: 'إسمنت',
        unit: 't',
        level: 42.5,
        coverDays: 4,
        shortageDate: '2026-10-30',
        orderBy: '2026-10-28',
        late: false,
        needsOrder: true,
      },
      {
        nameFr: 'Sable',
        nameAr: 'رمل',
        unit: 't',
        level: 120,
        coverDays: null,
        shortageDate: null,
        orderBy: null,
        late: false,
        needsOrder: false,
      },
    ],
  },
  uninvoiced_bls: {
    count: 1,
    clients: [
      {
        client: 'CLT-001',
        blCount: 2,
        totalM3: 5,
        bls: [
          {
            bl: 'BL-2026-00012',
            loadDate: '2026-10-24',
            deliveredDate: '2026-10-24',
            m3: 3,
            product: 'B25',
            amountHtCentimes: 234000,
          },
        ],
        ttcCentimes: 468000,
      },
    ],
  },
  open_invoices: {
    count: 2,
    openTotalCentimes: 900000,
    invoices: [
      {
        number: 'FA-2026-00004',
        client: 'CLT-001',
        dueDate: '2026-10-20',
        overdue: true,
        daysOverdue: 6,
        totalCentimes: 500000,
        paidCentimes: 0,
        openCentimes: 500000,
      },
      {
        number: 'FA-2026-00005',
        client: null,
        dueDate: '2026-11-20',
        overdue: false,
        daysOverdue: 0,
        totalCentimes: 400000,
        paidCentimes: 0,
        openCentimes: 400000,
      },
    ],
  },
  forecast: {
    horizonDays: 7,
    cashTodayCentimes: 1200000,
    days: [],
    lowest: { date: '2026-10-29', balanceCentimes: -50000 },
    black: { date: '2026-10-29', severity: 'risk', scenario: 'base', shortfallCentimes: 300000 },
    alertCount: 2,
    alerts: [],
  },
  order_chain: {
    found: true,
    order: {
      code: 'CMD-2026-00012',
      client: 'CLT-001',
      product: 'B25',
      orderDate: '2026-10-20',
      deliveryDate: '2026-10-24',
      cancelled: false,
      stages: { orderedM3: 10, plannedM3: 10, loadedM3: 5, deliveredM3: 5, invoicedM3: 5, paid: 'unpaid' },
    },
  },
  find_document: {
    count: 2,
    documents: [
      { kind: 'bl', number: 'BL-2026-00012', openable: true },
      { kind: 'payment', number: null, openable: false },
    ],
  },
  purchase_status: {
    count: 1,
    purchases: [
      {
        code: 'ACH-2026-00003',
        supplier: 'FRN-01',
        orderDate: '2026-10-20',
        status: 'partial',
        cancelled: false,
        lines: [{ name: 'Ciment', unit: 't', orderedQty: 30, receivedQty: 12 }],
        invoices: [
          { code: 'FF-2026-00001', state: 'entered', gapLines: 1, flags: ['PRICE'], totalCentimes: 100000 },
        ],
      },
    ],
  },
  consumption_variance: {
    month: '2026-10',
    toleranceBp: 200,
    producedM3: 210.5,
    count: 1,
    components: [
      {
        nameFr: 'Ciment',
        nameAr: 'إسمنت',
        unit: 't',
        theoretical: 70,
        adjustments: -2.5,
        counted: true,
        actual: 72.5,
        variance: 2.5,
        flagged: true,
      },
    ],
  },
  plan_order: { drafted: true, action: 'plan_order', note: 'x' },
  invoice_from_bls: { drafted: true, action: 'invoice_from_bls', note: 'x' },
  record_return: { error: 'The draft could not be prepared.', reason: 'NOT_FOUND' },
  record_payment: { error: 'The draft could not be prepared.', reason: 'NEEDS_AMOUNT' },
};

function answerFor(tool: string, lang: 'fr' | 'ar', question = 'Question sur CLT-001 ?') {
  const ps = new Pseudonymizer([]);
  const prepared = prepareForModel(RESULTS[tool], ps);
  const messages: LlmMessage[] = [
    { role: 'user', content: question },
    { role: 'assistant', content: '', toolCalls: [{ id: 'x', name: tool, args: {} }] },
    { role: 'tool', toolCallId: 'x', name: tool, content: toDataBlock(tool, prepared).text },
  ];
  const request: LlmRequest = {
    tier: 'analysis',
    system: lang === 'ar' ? 'Answer in Arabic' : 'Answer in French',
    messages,
    tools: [],
  };
  const response = fakeScript(() => ({ today: '2026-10-26' }))(request);
  return { text: response.text ?? '', allowed: allowedFrom([prepared], question) };
}

describe('the scripted answers go through the same checks as a real model’s', () => {
  it.each(Object.keys(RESULTS).flatMap((t) => [[t, 'fr'] as const, [t, 'ar'] as const]))(
    '%s in %s: plain text, and every number it quotes is one the tool returned',
    (tool, lang) => {
      const { text, allowed } = answerFor(tool, lang);
      expect(text.length).toBeGreaterThan(5);
      expect(isPlainText(text), text).toBe(true);
      expect(checkNumbers(text, allowed), text).toEqual({ ok: true, rejected: 0 });
    },
  );

  it('says the amounts as placeholders, never as figures, and the sign of a negative one', () => {
    const { text } = answerFor('open_invoices', 'fr');
    expect(text).toMatch(/\{\{AMT_\d+\}\}/);
    expect(text).not.toMatch(/500000|5000,00/);
    expect(answerFor('forecast', 'fr').text).toContain('négatif');
    expect(answerFor('forecast', 'ar').text).toContain('سالب');
  });

  it('answers a refusal from a draft with the reason in words, and a missing tool with a refusal', () => {
    expect(answerFor('record_payment', 'fr').text).toContain('montant');
    expect(answerFor('record_return', 'ar').text).toContain('لا أجد');
    const script = fakeScript(() => ({ today: '2026-10-26' }));
    const none = script({
      tier: 'analysis',
      system: 'Answer in French',
      messages: [{ role: 'user', content: 'Blablabla' }],
      tools: [],
    });
    expect(none.toolCalls).toEqual([]);
    expect(none.text).toContain('Je ne peux pas répondre');
  });
});
