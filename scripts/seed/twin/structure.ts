// T20 item 1: the structure of the twin: recipes and doses (assumption set A1, D237), product classes, vehicles, pumps, drivers, about 30 clients with their
// aliases and terms, about 12 suppliers. Everything goes through the application's own services as the owner (RBAC, validation, audit), never around them.
import type pg from 'pg';
import {
  createClient,
  createListPrice,
  createPurchasePrice,
  listPurchasePrices,
  replacePurchaseTransport,
  createRecetteVersion,
  createSupplier,
  createTruck,
  listComponents,
  listConcreteTypes,
  listTrucks,
  updateTruck,
} from '../../../src/modules/master-data/index.ts';
import { addClientAlias, setClientTerms } from '../../../src/modules/ledger/index.ts';
import {
  type ClientSpec,
  EXTRA_CLIENTS,
  EXTRA_SUPPLIERS,
  PILOT_CLIENTS,
  fakeIce,
  fakePhone,
} from './data.ts';
import { type TwinContext, must } from './context.ts';

export interface TwinClient {
  id: string;
  code: string;
  spec: ClientSpec;
}
export interface TwinTruck {
  id: string;
  code: string;
  plantId: string;
  capacityL: number;
}
export interface World {
  clients: TwinClient[];
  suppliers: { id: string; code: string; name: string; category: string }[];
  types: Map<string, string>;
  components: Map<string, { id: string; baseUnit: string }>;
  mixers: { TET: TwinTruck[]; CHF: TwinTruck[] };
  pumps: { id: string; code: string }[];
  /** zone name -> id */
  zones: Map<string, string>;
}

const nameKey = (s: string) => s.trim().toLowerCase();

export async function buildStructure(ctx: TwinContext): Promise<World> {
  const { app, migrator } = ctx.pools;
  const { owner, plants } = ctx;

  const types = new Map((await listConcreteTypes(app, owner)).map((t) => [t.code, t.id]));
  const components = new Map(
    (await listComponents(app, owner)).map((c) => [c.nameFr, { id: c.id, baseUnit: c.baseUnit as string }]),
  );
  const comp = (name: string) => components.get(name)!.id;

  // Product classes and recipes (A1, D237). The master-data seed holds B20, B25, B30 for all plants; the twin adds the two other classes and one
  // own mix per plant (a plant's own recipe wins for that plant). Doses are integer base units per m³ (g, L, mL); invented, deliberately round.
  const mix = (c: number, s: number, g1: number, g2: number, w: number, a: number) => [
    { componentId: comp('Ciment'), qtyPerM3: c },
    { componentId: comp('Sable'), qtyPerM3: s },
    { componentId: comp('Gravette 8/15'), qtyPerM3: g1 },
    { componentId: comp('Gravette 15/25'), qtyPerM3: g2 },
    { componentId: comp('Eau'), qtyPerM3: w },
    { componentId: comp('Adjuvant'), qtyPerM3: a },
  ];
  const from = '2026-01-02';
  must(
    'recipe B15',
    await createRecetteVersion(app, owner, types.get('B15')!, {
      effectiveFrom: from,
      lines: mix(260_000, 850_000, 430_000, 640_000, 190, 2_500),
    }),
  );
  must(
    'recipe B35',
    await createRecetteVersion(app, owner, types.get('B35')!, {
      effectiveFrom: from,
      lines: mix(450_000, 750_000, 370_000, 560_000, 170, 4_500),
    }),
  );
  must(
    'recipe B25 CHF',
    await createRecetteVersion(app, owner, types.get('B25')!, {
      plantId: plants.CHF.id,
      effectiveFrom: from,
      lines: mix(335_000, 830_000, 380_000, 610_000, 182, 3_200),
    }),
  );
  must(
    'recipe B30 TET',
    await createRecetteVersion(app, owner, types.get('B30')!, {
      plantId: plants.TET.id,
      effectiveFrom: from,
      lines: mix(415_000, 770_000, 380_000, 570_000, 172, 4_200),
    }),
  );
  // List prices (HT per m³, centimes) for the two new classes and a price per plant for the others; the master data already holds the base list.
  for (const [code, centimes, plant] of [
    ['B15', 70_000, null],
    ['B35', 99_000, null],
    ['B25', 87_000, plants.CHF.id],
    ['B25', 86_000, plants.TET.id],
    ['B30', 95_000, plants.CHF.id],
    ['B20', 80_000, plants.CHF.id],
  ] as const)
    must(
      `price ${code}`,
      await createListPrice(app, owner, {
        concreteTypeId: types.get(code)!,
        ...(plant ? { plantId: plant } : {}),
        priceHtPerM3Centimes: centimes,
        effectiveFrom: from,
      }),
    );

  // Purchase prices: the cement price rises by 3 % on 1 Oct (a second version, the first stays); the transport that makes each price a delivered price is an
  // assumption of set A1 (invented, in centimes per purchase unit). Without it every BL cost snapshot would be listed as incomplete (D241).
  const cement = (await listPurchasePrices(app, owner, comp('Ciment')))[0]!;
  must(
    'cement price Oct',
    await createPurchasePrice(app, owner, {
      componentId: cement.componentId,
      supplierId: cement.supplierId,
      purchaseUnitId: cement.purchaseUnitId,
      priceHtCentimes: Math.round(cement.priceHtCentimes * 1.03),
      effectiveFrom: '2026-10-01',
    }),
  );
  const TRANSPORT: Record<string, number> = {
    Ciment: 3_500,
    Sable: 2_500,
    'Gravette 8/15': 2_500,
    'Gravette 15/25': 2_500,
    Eau: 0,
    Adjuvant: 0,
  };
  for (const [name, centimes] of Object.entries(TRANSPORT))
    for (const price of await listPurchasePrices(app, owner, comp(name)))
      must(
        `transport ${name}`,
        await replacePurchaseTransport(app, owner, {
          priceId: price.id,
          transportCentimes: centimes,
          sourceNote: 'assumption A1: invented delivery cost to the plant',
          reason: 'twin seed (D251), assumption set A1',
        }),
      );

  // Vehicles: the four pilot mixers go to Tétouan (16 m³ as in the training base), Chefchaouen gets five smaller ones; three pump trucks (one per plant plus one shared).
  const pilotTrucks = (await listTrucks(app, owner)).filter((t) => t.kind === 'mixer');
  const mixersTet: TwinTruck[] = [];
  for (const t of pilotTrucks.slice(0, 4)) {
    must(
      `truck ${t.code}`,
      await updateTruck(app, owner, t.id, { plate: t.plate, capacityL: 16_000, plantId: plants.TET.id }),
    );
    mixersTet.push({ id: t.id, code: t.code, plantId: plants.TET.id, capacityL: 16_000 });
  }
  const mixersChf: TwinTruck[] = [];
  for (let i = 0; i < 5; i++) {
    const capacityL = i < 3 ? 11_000 : 8_000;
    const t = must(
      `truck T${5 + i}`,
      await createTruck(app, owner, {
        code: `T${5 + i}`,
        plate: `20${i + 1}01-D-6`,
        capacityL,
        plantId: plants.CHF.id,
      }),
    );
    mixersChf.push({ id: t.id, code: t.code, plantId: plants.CHF.id, capacityL });
  }
  const pumps: World['pumps'] = [];
  for (let i = 1; i <= 3; i++) {
    const p = must(
      `pump P${i}`,
      await createTruck(app, owner, { code: `P${i}`, plate: `POMPE-JUMEAU-${i}`, kind: 'pump' }),
    );
    pumps.push({ id: p.id, code: p.code });
  }

  // Suppliers: the five of the master data stay, seven are added (cement, sand, gravel, admixtures, transport, fuel, spare parts).
  const suppliers: World['suppliers'] = [];
  for (const [i, s] of EXTRA_SUPPLIERS.entries()) {
    const r = must(
      `supplier ${s.name}`,
      await createSupplier(app, owner, {
        name: s.name,
        category: s.category,
        ice: fakeIce(900 + i),
        phone: fakePhone(9100 + i),
        paymentTermsDays: s.terms,
        leadTimeDays: s.lead,
      }),
    );
    suppliers.push({ id: r.id, code: r.code, name: s.name, category: s.category });
  }
  const existing = await migrator.query<{ id: string; code: string; name: string; category: string }>(
    `select id, code, name, category from supplier where status = 'active'`,
  );
  for (const r of existing.rows) if (!suppliers.some((s) => s.id === r.id)) suppliers.push(r);

  // Clients: the five of the master data (looked up by name) and twenty-five new ones. Terms and aliases through the owner's own doors.
  const zones = new Map(
    (await migrator.query<{ id: string; name: string }>('select id, name from zone')).rows.map((z) => [
      z.name,
      z.id,
    ]),
  );
  const have = new Map(
    (
      await migrator.query<{ id: string; code: string; name: string }>('select id, code, name from client')
    ).rows.map((c) => [nameKey(c.name), c]),
  );
  const clients: TwinClient[] = [];
  let n = 0;
  for (const spec of [...PILOT_CLIENTS, ...EXTRA_CLIENTS]) {
    n += 1;
    let row = have.get(nameKey(spec.name));
    if (!row) {
      const created = must(
        `client ${spec.name}`,
        await createClient(app, owner, {
          name: spec.name,
          kind: spec.kind,
          ...(spec.kind === 'company' ? { ice: fakeIce(n) } : {}),
          phone: fakePhone(n),
          paymentTermsDays: spec.terms,
        }),
      );
      row = { id: created.client.id, code: created.client.code, name: spec.name };
    }
    clients.push({ id: row.id, code: row.code, spec });
    if (spec.poRequired || spec.basis === 'TTC')
      must(
        `terms ${spec.name}`,
        await setClientTerms(app, owner, {
          clientId: row.id,
          poRequired: spec.poRequired ?? false,
          priceBasis: spec.basis ?? 'HT',
        }),
      );
    for (const alias of spec.aliases ?? [])
      must(`alias ${alias}`, await addClientAlias(app, owner, { clientId: row.id, alias }));
  }
  return {
    clients,
    suppliers,
    types,
    components,
    mixers: { TET: mixersTet, CHF: mixersChf },
    pumps,
    zones,
  };
}

export type { pg };
