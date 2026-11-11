import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { invoicePdf } from '../src/modules/ledger/pdf/documents';
import { deliveryNotePdf } from '../src/modules/operations/pdf/delivery-note-pdf';

// KAYAS rebrand guard. The product was named BELGOBETON; that name must not reach anything a user, a driver, a client or a supplier can see.
//
// Tier 1 (zero tolerance, no allowlist): the user-visible surface: message catalogs (fr, ar, ary), public/ (manifests, service workers),
//   the TOTP issuer, and the bytes of rendered PDF documents.
// Tier 2 (source, scripts, docs, tests): the old name is refused everywhere EXCEPT the explicit allowlist below, each entry with its reason.
//   Out of scope by decision 204 (Phase 1): database role and database names, the 111 applied migrations, the local folder names, the
//   past review reports and the decision log (history keeps the old name). They are inventoried for Phase 2 (docs/BRAND-KAYAS.md).

const OLD = /belgo[\s_-]?b[eé]ton|belgo\b/gi;

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.ico', '.woff2', '.pdf', '.xlsx', '.lock']);
const text = (f: string) => readFileSync(f, 'utf8');

describe('tier 1: the user-visible surface never says BELGOBETON', () => {
  const surface = tracked.filter(
    (f) => (/^messages\/[^/]+\.json$/.test(f) || /^public\//.test(f)) && !BINARY.has(extname(f)),
  );
  it('covers the message catalogs, the manifests and the service workers', () => {
    expect(surface).toEqual(
      expect.arrayContaining([
        'messages/fr.json',
        'messages/ar.json',
        'messages/ary.json',
        'public/app.webmanifest',
        'public/driver.webmanifest',
        'public/sw.js',
        'public/driver-sw.js',
      ]),
    );
  });
  it.each(surface)('%s', (f) => {
    expect(text(f).match(OLD) ?? []).toEqual([]);
  });

  it('the application name in the catalogs, the manifests and the TOTP issuer is KAYAS', () => {
    for (const l of ['fr', 'ar']) expect(JSON.parse(text(`messages/${l}.json`)).shell.title).toBe('KAYAS');
    expect(JSON.parse(text('public/app.webmanifest'))).toMatchObject({ name: 'KAYAS', short_name: 'KAYAS' });
    expect(JSON.parse(text('public/driver.webmanifest')).name).toMatch(/^KAYAS/);
    expect(text('src/modules/platform-security/domain/totp-qr.ts')).toContain("TOTP_ISSUER = 'KAYAS'");
    expect(text('src/modules/platform-security/auth/options.ts')).toContain("issuer: 'KAYAS'");
  });

  it('rendered PDF documents (text and Producer) never say BELGOBETON', () => {
    const company = {
      effectiveFrom: '2026-01-01',
      legalName: 'Société fictive',
      legalForm: 'SARL',
      ice: '1',
      ifNumber: '1',
      rcNumber: '1',
      patente: '1',
      address: 'x',
      phone: null,
      email: null,
      rib: null,
    };
    const invoice = invoicePdf(
      {
        invoice: {
          number: 'F-1',
          creditNoteOf: null,
          clientName: 'C',
          clientIce: null,
          invoiceDate: 'd',
          dueDate: 'd',
          orderCodes: [],
          reason: null,
          totalHtCentimes: 0,
          vatRateBp: 0,
          totalVatCentimes: 0,
          totalTtcCentimes: 0,
        },
        creditNoteOfNumber: null,
        lines: [],
        groups: [],
        advanceCentimes: 0,
        netToPayCentimes: 0,
        termDays: 30,
      } as unknown as Parameters<typeof invoicePdf>[0],
      { company, specimen: false },
    );
    const bl = deliveryNotePdf(
      {
        blNo: 'B',
        cancelled: false,
        loadDate: 'd',
        loadedAt: '2026-11-07T08:00:00Z',
        orderCode: 'o',
        clientName: 'c',
        clientCode: 'c',
        siteLabel: 's',
        zoneName: 'z',
        typeCode: 't',
        typeLabel: 'l',
        volumeL: 1000,
        truckCode: 'T',
        truckPlate: 'P',
      } as unknown as Parameters<typeof deliveryNotePdf>[0],
      { specimen: false, company: [] },
    );
    for (const bytes of [invoice, bl]) {
      expect(Buffer.from(bytes).toString('latin1').match(OLD) ?? []).toEqual([]);
      expect(Buffer.from(bytes).toString('latin1')).toContain('/Producer (KAYAS)');
    }
  });
});

/** Allowed leftovers of the old name, each with its reason. A line is clean when nothing is left after removing these. */
const ALLOWED: { reason: string; pattern: RegExp }[] = [
  {
    reason:
      'the pre-rebrand training compose project, quoted as such in the training checkpoints (history of an existing deployment)',
    pattern: /`belgobeton-training`/g,
  },
  {
    reason:
      'R16-04: the pre-KAYAS compose project and its volumes (belgobeton-training, belgobeton-training_pgdata ...), named on purpose by the upgrade procedure and by the pre-check that refuses to start beside that stack',
    pattern: /belgobeton-training(?:_[a-z]+)?/g,
  },
  {
    reason:
      'E: database role names (belgobeton_app, _system, _auth, _migrator, _seed, _backup, ...) and database names (_test, _e2e, _training...)',
    pattern: /belgobeton_[a-z_]+/gi,
  },
  {
    reason: 'E: the database named belgobeton in connection strings and psql/pg_dump commands',
    pattern: /(?:\/|-Fc |-d |-U postgres )belgobeton\b(?![-\w.])/g,
  },
  {
    reason:
      "E: the cluster's database name in prose about the roles and databases (belgobeton + belgobeton_test)",
    pattern: /\+ belgobeton \+/g,
  },
  {
    reason:
      'local folder names (~/BELGOBETON, ~/BELGOBETON-finance, -data, -training-private, ~/belgobeton) are out of scope in Phase 1',
    pattern:
      /(?:~|\$HOME|\/Users\/[a-z]+)?\/?BELGOBETON(?:-finance|-data|-training-private)?\b|~\/belgobeton\b|\$HOME\/belgobeton\b/g,
  },
  {
    reason: "the finance worktree's compose project and volume (local, out of scope)",
    pattern: /belgobeton-finance(?:[\w-]*)/g,
  },
  {
    reason: 'the legacy browser database name, kept only so the wipe paths can delete it (delete-only)',
    pattern: /belgobeton-field/g,
  },
  {
    reason:
      'cryptographic / lock context strings kept byte-identical (changing them would invalidate sessions or the import lock): HKDF info and advisory lock key',
    pattern: /'belgobeton'|'belgobeton:excel-import'/g,
  },
  {
    reason: 'the history importer lock key, byte-identical like the Excel import one (T11)',
    pattern: /'belgobeton:history-import'/g,
  },
  {
    reason:
      'BELGO is how the company\'s monthly files tag the Tétouan plant ("BETON BELGO MM.2026"): a plant tag the history importer maps by configuration, not the product name (T11, decision 210)',
    pattern: /\bBELGO\b(?!BETON)/gi,
  },
  {
    reason: 'the former name quoted on purpose ("formerly BELGOBETON")',
    pattern:
      /formerly BELGOBETON|ex-BELGOBETON|former(?: working)? name(?: \(?|:? )BELGOBETON|BELGOBETON \(former|BELGOBETON is OBSOLETE|BELGOBETON → KAYAS|old name BELGOBETON|BELGOBETON\)/gi,
  },
  {
    reason: 'the GitHub repository / training iMac clone path (repository name unchanged in Phase 1)',
    pattern: /aliescoobs-sudo\/beton ~\/belgobeton/g,
  },
];
// Files whose content is history or the brand documentation itself.
const HISTORY = [
  /^db\/migrations\//,
  /^docs\/reviews\//,
  /^docs\/DECISIONS\.md$/,
  /^docs\/LEAD-HANDOFF\.md$/,
  /^docs\/BRAND-KAYAS\.md$/,
  /^brand-incoming\//,
  /^scripts\/brand-guard\.test\.ts$/,
];

describe('tier 2: the rest of the repository keeps the old name only where the allowlist says', () => {
  const files = tracked.filter((f) => !BINARY.has(extname(f)) && !HISTORY.some((h) => h.test(f)));
  it('has no stray BELGOBETON', () => {
    const stray: string[] = [];
    for (const f of files) {
      let content: string;
      try {
        content = text(f);
      } catch {
        continue;
      }
      for (const [i, line] of content.split('\n').entries()) {
        let rest = line;
        for (const a of ALLOWED) rest = rest.replace(a.pattern, ' ');
        if (OLD.test(rest)) stray.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        OLD.lastIndex = 0;
      }
    }
    expect(stray).toEqual([]);
  });
});
