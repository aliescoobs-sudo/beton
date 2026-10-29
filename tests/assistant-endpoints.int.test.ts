import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeProvider } from '../src/lib/ai/fake-provider';
import type { LlmResponse } from '../src/lib/ai/llm-provider';
import { parseKeyring } from '../src/lib/crypto/keyring';
import { withRlsContext } from '../src/lib/db/rls-context';
import { cipherFrom } from '../src/modules/assistant/service/cipher';
import {
  confirm,
  ask,
  type EndpointContext,
  proposals,
  reject,
} from '../src/modules/assistant/service/endpoints';
import { loadLeakIndex } from '../src/modules/assistant/service/leak-index';
import { providerFor } from '../src/modules/assistant/service/provider-factory';
import type { SessionUser } from '../src/modules/platform-security/auth/session-gate';
import { defaultParameters } from '../src/modules/platform-security/domain/parameters';
import { engineParams } from '../src/modules/rules-engine';
import { testEnv } from './db-env';
import { realSessionUser } from './helpers/actors';
import { clientWithLoads, deliveryScene, newDelivery, orderMaster } from './helpers/ledger-fixtures';

// assistant A8 (SPEC-assistant §9; AC-ASSIST-01, 02, 12, 26): the endpoints' logic, with the flag off and on.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 });
const auth = new pg.Pool({ connectionString: env.DATABASE_URL_AUTH, max: 2 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 2 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
afterAll(() => Promise.all([app.end(), auth.end(), system.end(), migrator.end()]));

const cipher = cipherFrom(parseKeyring(`t1:${Buffer.alloc(32, 5).toString('base64')}`));
const marker = `ae${randomUUID()
  .replace(/-/g, '')
  .slice(0, 10)
  .replace(/\d/g, (d) => 'ghijklmnop'[Number(d)] as string)}`;
let owner: SessionUser;
let office: SessionUser;
let plant: SessionUser;

/** A pool that fails the test if anything touches it. */
const forbidden = () =>
  new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('a pool was used');
      },
    },
  ) as unknown as pg.Pool;
const reply = (over: Partial<LlmResponse>): LlmResponse => ({
  text: null,
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  model: 'fake',
  ...over,
});

const ctx = (user: SessionUser, over: Partial<EndpointContext> = {}): EndpointContext => ({
  enabled: true,
  user,
  appPool: app,
  authPool: auth,
  systemPool: system,
  cipher,
  hmacKey: Buffer.alloc(32, 6).toString('base64'),
  today: '2026-06-02',
  engine: engineParams(defaultParameters()),
  model: 'fake',
  provider: () => new FakeProvider(() => reply({ text: 'Bonjour.' })),
  leakIndex: () => loadLeakIndex(system, cipher),
  stepUp: async (fn) => ({ ok: true, value: await fn(user) }),
  ...over,
});

beforeAll(async () => {
  owner = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'owner');
  office = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'office');
  plant = await realSessionUser(env.DATABASE_URL_MIGRATOR, 'plant');
});

describe('with the flag off (AC-ASSIST-01)', () => {
  it('answers 404 before it reads a body, touches a pool or asks for a provider', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = vi.fn(() => new FakeProvider(() => reply({ text: 'x' })));
    const off = ctx(office, {
      enabled: false,
      appPool: forbidden(),
      authPool: forbidden(),
      systemPool: forbidden(),
      provider,
      leakIndex: async () => {
        throw new Error('read');
      },
    });
    for (const run of [
      () => ask(off, { question: 'Bonjour' }),
      () => ask(off, 'not even json'),
      () => proposals(off),
      () => confirm(off, randomUUID()),
      () => reject(off, randomUUID()),
    ])
      expect(await run()).toEqual({ status: 404, body: { error: 'NOT_FOUND' } });
    expect(provider).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('builds no provider at all, so there is no call counter to move', () => {
    expect(
      providerFor(
        {
          ASSISTANT_ENABLED: false,
          ASSISTANT_PROVIDER: 'fake',
          ASSISTANT_MODEL: 'm',
          ANTHROPIC_API_KEY: undefined,
          REAL_DATA: false,
          NODE_ENV: 'test',
        },
        '2026-06-02',
      ),
    ).toBeNull();
    expect(
      providerFor(
        {
          ASSISTANT_ENABLED: false,
          ASSISTANT_PROVIDER: 'anthropic',
          ASSISTANT_MODEL: 'm',
          ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdefghij',
          REAL_DATA: false,
          NODE_ENV: 'test',
        },
        '2026-06-02',
      ),
    ).toBeNull();
  });

  it('records nothing: no turn, no draft', async () => {
    const before = Number(
      (
        await withRlsContext(app, { userId: office.id, role: 'office', requestId: marker }, (tx) =>
          tx.query('select count(*)::int as n from ai_interaction'),
        )
      ).rows[0].n,
    );
    await ask(ctx(office, { enabled: false }), { question: 'Bonjour' });
    const after = Number(
      (
        await withRlsContext(app, { userId: office.id, role: 'office', requestId: marker }, (tx) =>
          tx.query('select count(*)::int as n from ai_interaction'),
        )
      ).rows[0].n,
    );
    expect(after).toBe(before);
  });
});

describe('the provider is chosen by the rules of §3 (AC-ASSIST-26)', () => {
  const base = {
    ASSISTANT_ENABLED: true,
    ASSISTANT_MODEL: 'm',
    ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdefghij',
    REAL_DATA: false,
    NODE_ENV: 'test' as const,
  };

  it('is the scripted Fake provider by default, and it makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = providerFor({ ...base, ASSISTANT_PROVIDER: 'fake' }, '2026-06-02');
    expect(provider?.id).toBe('fake');
    const r = await provider!.generate({
      tier: 'analysis',
      system: 'Answer in French',
      messages: [{ role: 'user', content: 'Quels camions chargent aujourd’hui ?' }],
      tools: [{ name: 'deliveries_today', description: 'd', parameters: {} }],
    });
    expect(r.toolCalls[0]?.name).toBe('deliveries_today');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses the real adapter with real data or in production, and says nothing about why to the caller', async () => {
    for (const bad of [
      { REAL_DATA: true },
      { NODE_ENV: 'production' as const },
      { ANTHROPIC_API_KEY: undefined },
    ])
      expect(() => providerFor({ ...base, ASSISTANT_PROVIDER: 'anthropic', ...bad }, '2026-06-02')).toThrow();
    const out = await ask(
      ctx(office, {
        provider: () =>
          providerFor({ ...base, ASSISTANT_PROVIDER: 'anthropic', REAL_DATA: true }, '2026-06-02'),
      }),
      { question: 'Bonjour' },
    );
    expect(out).toEqual({ status: 503, body: { error: 'UNAVAILABLE' } });
  });
});

describe('ask', () => {
  it('refuses a body that is not exactly a question and a bounded history', async () => {
    for (const body of [
      undefined,
      null,
      {},
      { question: '' },
      { question: 'x'.repeat(601) },
      { question: 'ok', as: 'owner' },
      { question: 'ok', history: Array.from({ length: 11 }, () => ({ question: 'a', answer: 'b' })) },
      { question: 'ok', history: [{ question: 'a', answer: 'b', role: 'system' }] },
    ])
      expect(await ask(ctx(office), body), JSON.stringify(body)?.slice(0, 40)).toEqual({
        status: 400,
        body: { error: 'INVALID' },
      });
  });

  it('answers a question with the turn, for the person who asked', async () => {
    const out = await ask(ctx(plant), { question: 'Bonjour' });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ outcome: 'ok', answer: 'Bonjour.', fallback: false, refusal: null });
  });
});

describe('confirming a money draft goes through the second factor (AC-ASSIST-12)', () => {
  it('asks for it, claims nothing without it, and confirms with it; a return needs none', async () => {
    const scene = await deliveryScene(app, owner.id, marker);
    const master = await orderMaster(app, owner.id, marker);
    const c = await clientWithLoads(app, owner.id, master, scene, [[3000]]);
    const load = await newDelivery(app, owner.id, marker, scene, 600);
    const drafts = new FakeProvider((request) =>
      request.messages.some((m) => m.role === 'tool')
        ? reply({ text: 'Voici le brouillon.' })
        : reply({
            toolCalls: [
              {
                id: 'd',
                name: request.tools.some((t) => t.name === 'invoice_from_bls')
                  ? 'invoice_from_bls'
                  : 'record_return',
                args: request.tools.some((t) => t.name === 'invoice_from_bls')
                  ? { client: c.clientCode, bl_numbers: c.orders[0]!.blNos }
                  : { bl: load.blNo, reason: 'quality' },
              },
            ],
          }),
    );
    const gate = async () => ({ refusal: null, budgetPercent: 0 });
    void gate;
    const made = (await ask(ctx(office, { provider: () => drafts }), { question: 'Facture' })).body as {
      proposals: { id: string }[];
    };
    expect(made.proposals).toHaveLength(1);
    const id = made.proposals[0]!.id;
    const refusing = ctx(office, { stepUp: async () => ({ ok: false, error: 'STEP_UP_REQUIRED' }) });
    expect(await confirm(refusing, id)).toEqual({ status: 403, body: { error: 'STEP_UP_REQUIRED' } });
    const still = (await proposals(ctx(office))).body as { proposals: { id: string; status: string }[] };
    expect(still.proposals.find((p) => p.id === id)?.status).toBe('pending');
    const done = await confirm(ctx(office), id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ proposal: { status: 'confirmed' } });
    expect((await confirm(ctx(office), id)).status).toBe(409);
    expect((await confirm(ctx(office), randomUUID())).status).toBe(404);
    expect((await confirm(ctx(plant), id)).status).toBe(404);
    // A return writes no money: no second factor, even if the guard would refuse.
    const ret = (await ask(ctx(plant, { provider: () => drafts }), { question: 'Retour' })).body as {
      proposals: { id: string }[];
    };
    const refusingPlant = ctx(plant, { stepUp: async () => ({ ok: false, error: 'STEP_UP_REQUIRED' }) });
    expect((await confirm(refusingPlant, ret.proposals[0]!.id)).status).toBe(200);
    // Refusing a draft.
    const second = await clientWithLoads(app, owner.id, master, scene, [[1000]]);
    const again = new FakeProvider((request) =>
      request.messages.some((m) => m.role === 'tool')
        ? reply({ text: 'Voici.' })
        : reply({
            toolCalls: [
              {
                id: 'd',
                name: 'invoice_from_bls',
                args: { client: second.clientCode, bl_numbers: second.orders[0]!.blNos },
              },
            ],
          }),
    );
    const third = (await ask(ctx(office, { provider: () => again }), { question: 'Facture' })).body as {
      proposals: { id: string }[];
    };
    expect((await reject(ctx(office), third.proposals[0]!.id)).body).toMatchObject({
      proposal: { status: 'rejected' },
    });
    expect((await confirm(ctx(office), third.proposals[0]!.id)).status).toBe(409);
  });
});
