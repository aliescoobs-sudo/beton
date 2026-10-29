import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { FakeProvider } from '@/lib/ai/fake-provider';
import { parseKeyring } from '@/lib/crypto/keyring';
import type { Env } from '@/lib/env';
import { withRlsContext } from '@/lib/db/rls-context';
import { uuidv7 } from '@/lib/uuidv7';
import { getInvoiceQueue } from '@/modules/ledger';
import { realClock } from '@/modules/clock';
import { listTrucks } from '@/modules/master-data';
import { createLoad, listDeliveries, listLoadableOrders, markDelivered } from '@/modules/operations';
import {
  BOOTSTRAP_ACTOR_ID,
  createAuth,
  createUser,
  readParameters,
  type SessionUser,
} from '@/modules/platform-security';
import { engineParams } from '@/modules/rules-engine';
import { fakeScript } from '../fake/script';
import { cipherFrom } from './cipher';
import { loadLeakIndex } from './leak-index';
import { runTurn } from './turn';

export interface WalkDeps {
  appPool: pg.Pool;
  authPool: pg.Pool;
  systemPool: pg.Pool;
  env: Env;
  /** The business date. */
  today: string;
  /** Accounts to play as instead of looking them up (tests). */
  users?: Partial<Record<'owner' | 'office' | 'plant', SessionUser>>;
}

export interface WalkResult {
  applied: boolean;
  turns: number;
  drafts: number;
  /** Roles whose walk was not played, and why (already played, no owner yet, nothing to show). */
  skipped: string[];
}

const DEMO_USERS = {
  office: { email: 'demo-assistant-office@belgobeton.test', name: 'Bureau (démo assistant)' },
  plant: { email: 'demo-assistant-plant@belgobeton.test', name: 'Centrale (démo assistant)' },
} as const;

async function userOf(deps: WalkDeps, role: 'owner' | 'office' | 'plant'): Promise<SessionUser | null> {
  if (deps.users?.[role]) return deps.users[role] ?? null;
  const find = async () => {
    const { rows } = await deps.authPool.query<{ id: string; name: string; email: string; locale: string }>(
      `select id, name, email, locale from "user"
        where role = $1 and status = 'active' and "provisionedAt" is not null order by "createdAt" limit 1`,
      [role],
    );
    return rows[0];
  };
  let row = await find();
  if (!row && role !== 'owner') {
    // A demo account of the role, made through the same door as any user. Its password is random and shown to nobody: the walk acts
    // through the service, the owner resets the account if a person wants to sign in as it.
    const auth = createAuth({ authPool: deps.authPool, env: deps.env });
    await createUser(auth, deps.authPool, {
      actor: { userId: BOOTSTRAP_ACTOR_ID, role: 'system' },
      ...DEMO_USERS[role],
      password: randomBytes(24).toString('base64url'),
      role,
      locale: 'fr',
    });
    row = await find();
  }
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role,
    locale: row.locale === 'ar' ? 'ar' : 'fr',
    twoFactorEnabled: true,
    reenrolRequired: false,
  };
}

const turnsOf = (deps: WalkDeps, user: SessionUser) =>
  withRlsContext(
    deps.appPool,
    { userId: user.id, role: user.role, requestId: uuidv7(realClock.now()) },
    async (tx) =>
      Number(
        (
          await tx.query<{ n: string }>('select count(*)::text as n from ai_interaction where user_id = $1', [
            user.id,
          ])
        ).rows[0]?.n ?? 0,
      ),
  );

/**
 * The assistant walk of the demo (CP-ASSIST-1, AC-ASSIST-30): the questions each role would ask on a morning, answered by the Fake
 * provider (no network), through the application's own door: every tool runs as that person under their row-level security, every
 * turn is recorded sealed and audited, and the drafts are left pending on their cards. Nothing is confirmed here: a money draft
 * needs its person's fresh second factor, and the demo clicks it in the screen. Idempotent per role: a role that has already
 * asked anything is not played again.
 */
export async function seedAssistantWalk(deps: WalkDeps): Promise<WalkResult> {
  const cipher = cipherFrom(parseKeyring(deps.env.FIELD_ENCRYPTION_KEYS));
  const turnDeps = {
    appPool: deps.appPool,
    authPool: deps.authPool,
    systemPool: deps.systemPool,
    model: 'fake',
    cipher,
    hmacKey: deps.env.LOOKUP_HMAC_KEY,
    today: deps.today,
    engine: engineParams(await readParameters(deps.authPool)),
    leakIndex: () => loadLeakIndex(deps.systemPool, cipher),
  };
  const result: WalkResult = { applied: false, turns: 0, drafts: 0, skipped: [] };
  const ask = async (user: SessionUser, question: string) => {
    const provider = new FakeProvider(fakeScript(() => ({ today: deps.today })));
    const out = await runTurn({ ...turnDeps, provider }, user, { question });
    result.turns += 1;
    result.drafts += out.proposals.length;
  };

  const owner = await userOf(deps, 'owner');
  const office = await userOf(deps, 'office');
  const plant = await userOf(deps, 'plant');
  let queue = owner ? await getInvoiceQueue(deps.appPool, owner) : [];
  if (owner && plant && !queue.some((c) => c.deliveries.length > 0) && (await turnsOf(deps, owner)) === 0) {
    // Nothing waits to be invoiced: the plant (the real door, as that person) loads 3 m³ of an open order and marks it delivered,
    // so that the owner's morning has a BL to invoice.
    const order = (await listLoadableOrders(deps.appPool, plant, deps.today))[0];
    const truck = (await listTrucks(deps.appPool, plant)).find((t) => t.status === 'active');
    if (order && truck) {
      const made = await createLoad(
        deps.appPool,
        plant,
        { orderId: order.id, truckId: truck.id, volumeL: Math.min(3000, order.remainingL) },
        { today: deps.today },
      );
      if (made.ok)
        await markDelivered(deps.appPool, plant, { deliveryId: made.value.id }, { now: realClock.now() });
    }
    queue = await getInvoiceQueue(deps.appPool, owner);
  }
  const client = queue.find((c) => c.deliveries.length > 0);

  if (!owner) result.skipped.push('owner: no owner account yet (corepack pnpm user:create-owner)');
  else if ((await turnsOf(deps, owner)) > 0) result.skipped.push('owner: already played');
  else {
    for (const q of [
      "Qu'est-ce qui est sorti aujourd'hui ?",
      'Combien de jours de couverture en ciment ?',
      "Qu'est-ce qu'il reste à facturer ?",
    ])
      await ask(owner, q);
    // The invoice draft: the owner confirms it in the panel, with the code of the authenticator.
    if (client)
      await ask(
        owner,
        `Facture les BL ${client.deliveries
          .slice(0, 2)
          .map((d) => d.blNo)
          .join(' ')} pour ${client.clientCode}`,
      );
    else result.skipped.push('owner: nothing to invoice, no invoice draft');
    for (const q of ['Quelles factures sont impayées ?', 'Quelle est la prévision de la semaine ?'])
      await ask(owner, q);
  }

  if (!office) result.skipped.push('office: no account');
  else if ((await turnsOf(deps, office)) > 0) result.skipped.push('office: already played');
  else {
    await ask(office, 'Quels BL ne sont pas encore facturés ?');
    if (client) await ask(office, `Enregistre un chèque 8451237 de 12 000 dh de ${client.clientCode}`);
    // A money question office has no tool for: the answer is a refusal.
    await ask(office, 'Quelles factures sont impayées ?');
  }

  if (!plant) result.skipped.push('plant: no account');
  else if ((await turnsOf(deps, plant)) > 0) result.skipped.push('plant: already played');
  else {
    await ask(plant, 'Quel est le prochain chargement ?');
    await ask(plant, 'Où en est le silo de ciment ?');
    const load = (await listDeliveries(deps.appPool, plant, 200)).find((d) => !d.cancelled && !d.loss);
    if (load) await ask(plant, `Enregistre le retour du BL ${load.blNo}, refusé par le client`);
    else result.skipped.push('plant: no load to return');
  }
  result.applied = result.turns > 0;
  return result;
}
