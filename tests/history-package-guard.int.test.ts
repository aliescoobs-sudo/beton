import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type HistoryEnvironment,
  type HistoryMapping,
  historyConfirmation,
  runHistory,
} from '../src/modules/importer';
import { readSet } from '../src/modules/importer/history/service/read-set';
import { readPackageParts } from '../src/modules/importer/domain/sheet';
import { type PackageEdit, rewritePackage } from '../src/modules/importer/domain/xlsx-writer';
import { buildTwin, twinMappings } from '../src/modules/importer/history/twin';
import { testEnv } from './db-env';
import { v1Actors } from './helpers/v1-actors';

// R18-09 on the T11 history reader: the SAME package guard (the reader is readXlsxSheets). A TWIN workbook whose main part is relocated,
// duplicated, missing, empty or malformed is refused as an unreadable file, and the apply writes nothing, in every table.
const env = testEnv();
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 3 });
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 });
const TRAINING: HistoryEnvironment = { trainingMode: true, realData: false, simulationEnabled: false };
const tag = randomUUID().replace(/-/g, '').slice(0, 6);
let A: Awaited<ReturnType<typeof v1Actors>>;
let plantCode: string;

beforeAll(async () => {
  A = await v1Actors(app, env.DATABASE_URL_MIGRATOR, `r18${tag}`);
  plantCode = (await migrator.query<{ code: string }>('select code from plant where id = $1', [A.plantId]))
    .rows[0]!.code;
});
afterAll(async () => {
  await A.done();
  await Promise.all([app.end(), migrator.end()]);
});

const mapping = (): HistoryMapping => ({
  ...(twinMappings()['deliveries-tetouan.json'] as HistoryMapping),
  plantCode,
});
const twinFile = () =>
  buildTwin({ belgoRows: 12, chaounRows: 12, belgoClients: 4, chaounClients: 3 })[0]!.buf;
const owner = () => ({ ...A.owner, stepUpVerified: true });
const count = async (sql: string) => Number((await migrator.query<{ n: string }>(sql)).rows[0]!.n);
const everything = async () => ({
  batch: await count('select count(*) n from history.batch'),
  label: await count('select count(*) n from history.label_map'),
  quarantine: await count('select count(*) n from history.quarantine'),
  delivery: await count('select count(*) n from history.delivery'),
  expense: await count('select count(*) n from history.expense'),
  audit: await count('select count(*) n from audit_event'),
  client: await count('select count(*) n from client'),
  stock: await count('select count(*) n from stock_movement'),
});

const edited = (edit: PackageEdit) => rewritePackage(readPackageParts(twinFile()), edit);
const MAIN = 'xl/workbook.xml';
const swap =
  (name: string, content: string): PackageEdit =>
  (e) =>
    e.map(([n, c]) => [n, n === name ? content : c]);

describe('the history reader refuses a package whose main workbook part cannot be trusted (R18-09)', () => {
  it('control: the valid 1900 twin is read without a file problem', async () => {
    const r = await runHistory({
      appPool: app,
      actor: owner(),
      files: [{ ord: 1, buf: twinFile() }],
      mapping: mapping(),
      environment: TRAINING,
      mode: 'dry-run',
    });
    expect(r.problems.filter((p) => /FILE_UNREADABLE/.test(p))).toEqual([]);
    expect(r.files[0]!.problems).toEqual([]);
  });

  const cases: [string, () => Buffer, RegExp][] = [
    [
      'a 1904 main part relocated (the decoy at the canonical name says 1900)',
      () =>
        edited((e) => [
          ...e.map(([n, c]): [string, string] => [
            n,
            n === '_rels/.rels' ? c.replace(MAIN, 'xl/moved/main.xml') : c,
          ]),
          [
            'xl/moved/main.xml',
            e
              .find(([n]) => n === MAIN)![1]
              .replace('<workbook ', '<workbook ')
              .replace(/<sheets>/, '<workbookPr date1904="1"/><sheets>'),
          ],
          [
            'xl/moved/_rels/main.xml.rels',
            e
              .find(([n]) => n === 'xl/_rels/workbook.xml.rels')![1]
              .replace(/Target="worksheets\//g, 'Target="../worksheets/'),
          ],
        ]),
      /1904/,
    ],
    ['a duplicate main part', () => edited((e) => [...e, [MAIN, '<workbook/>']]), /more than once/],
    [
      'a missing main part',
      () => edited((e) => e.filter(([n]) => n !== MAIN)),
      /readable workbook|date system/,
    ],
    ['an empty main part', () => edited(swap(MAIN, '')), /date system could not be determined/],
    [
      'a malformed main part',
      () => edited(swap(MAIN, '<workbook><sheets></workbook>')),
      /date system could not be determined/,
    ],
  ];
  for (const [title, make, why] of cases) {
    it(`${title}: the reader reports FILE_UNREADABLE and no mode writes anything`, async () => {
      const f = [{ ord: 1, buf: make() }];
      const read = readSet(f, mapping());
      expect(read.files[0]!.problems.join(' ')).toMatch(/FILE_UNREADABLE/);
      expect(read.files[0]!.problems.join(' ')).toMatch(why);
      expect(read.deliveries).toEqual([]);
      const before = await everything();
      for (const mode of ['dry-run', 'stage', 'apply'] as const) {
        // the file carries no readable marker, so the training guard refuses the run outright; either way nothing is written
        const outcome = await runHistory({
          appPool: app,
          actor: owner(),
          files: f,
          mapping: mapping(),
          environment: TRAINING,
          mode,
          stepUp:
            mode === 'apply'
              ? { userId: A.owner.id, operation: historyConfirmation(read.setSha, '0'.repeat(64)).operation }
              : undefined,
        }).then(
          (r) => ({ applied: r.applied }),
          (e: { code?: string }) => ({ refused: e.code }),
        );
        expect(outcome).not.toMatchObject({ applied: true });
      }
      expect(await everything()).toEqual(before);
    });
  }
});
