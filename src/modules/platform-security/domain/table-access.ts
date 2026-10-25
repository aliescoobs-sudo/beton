import type { DB_ROLES } from '@/lib/db/rls-context';

type DbRole = (typeof DB_ROLES)[number];
export type ReadScope = 'all' | 'own' | 'none';

interface RlsTable {
  kind: 'rls';
  /** Rows each request role may read (SPEC §4). */
  read: Record<DbRole, ReadScope>;
  /** FORCE ROW LEVEL SECURITY (also applies to the owner). false only with a documented reason. */
  force: boolean;
  /** Captured by audit.capture(). false only with a documented reason. */
  audited: boolean;
  exception?: string;
  /** Master data and financial records: belgobeton_app has no DELETE or TRUNCATE privilege (AC-MD-06, R12). */
  noDelete?: boolean;
  /**
   * The pilot seed role (belgobeton_seed, simulation only) may read and insert here; 'counter' also lets it bump the
   * code counter. belgobeton_system never inserts into such a table. See db/seed/seed-role.sql.
   */
  seed?: 'insert' | 'counter';
  /**
   * Money data (DECISIONS 81): partner, office, plant and the system read nothing; the owner and support read; only the
   * owner writes (office may insert blind where a later table allows it). tests/money-visibility.int.test.ts checks every
   * flagged table, and its audit rows are hidden from the others (audit.is_money_table).
   */
  money?: true;
  /** Roles that may INSERT into a money table without being able to read it back (blind entry, DECISIONS 81). */
  blindWriters?: readonly DbRole[];
  /** Versioned records: belgobeton_app has no UPDATE either (a change is a new row), e.g. recettes (AC-MD-02). */
  insertOnly?: boolean;
}

interface AuthOnlyTable {
  kind: 'auth_only';
  /** Readable only by belgobeton_auth; belgobeton_app has no privilege at all. */
  reason: string;
}

/**
 * Every table in the public schema, with its access rule. The meta-test (tests/rls/meta.int.test.ts) fails for a
 * table missing here or not matching its rule; the matrix test reads `read` to check RLS for every role.
 * Later modules add their business tables as `{ kind: 'rls', force: true, audited: true, read: … }`.
 */
export const TABLE_ACCESS = {
  audit_event: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'own',
      plant: 'own',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: false,
    audited: false,
    exception:
      'CP2: its SECURITY DEFINER writers run as the owner and must read the latest hash, so RLS is enabled, not ' +
      'forced; it is the audit log itself, so it is not captured by the audit trigger.',
  },
  parameter: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    exception:
      'Also readable by belgobeton_auth (login lockout runs before any session); writes: owner only.',
  },
  security_checklist_item: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    exception: 'Also readable by belgobeton_system (banner, REAL_DATA boot guard); writes: owner only.',
  },
  security_check_run: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    exception: 'Append-only automated evidence, inserted by belgobeton_system with the system actor only.',
  },
  security_alert: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    exception: 'Inserted by belgobeton_system with the system actor (break-glass CLI).',
  },
  security_alert_ack: {
    kind: 'rls',
    read: {
      owner: 'own',
      partner: 'own',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'none',
    },
    force: true,
    audited: true,
  },
  sim_clock: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    exception:
      'Singleton, SPEC-clock §3. Every signed-in role reads it (badge, clock.now()); also readable by ' +
      'belgobeton_auth (pre-session pages) and the owner via the ctx.sim_now() definer; updates: owner or system.',
  },
  scheduled_job_run: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    exception: 'SPEC-clock §3 idempotency ledger; written only by the system actor (job runner).',
  },
  zone: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    exception: 'master-data T2: managers write (zones.write); every signed-in role reads.',
  },
  component: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    exception:
      'master-data T6: managers write (components.write); every signed-in role reads; no price column.',
  },
  purchase_unit: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    exception: 'master-data T6: managers write (components.write); factor_to_base is immutable (trigger).',
  },
  concrete_type: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    exception:
      'master-data T7: managers write (recettes.write); office and plant read; code immutable (trigger).',
  },
  recette: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'master-data T8: insert-only versions, managers write (recettes.write); every role reads (no price column; ' +
      'office and plant see quantities, T9 projects the plant view).',
  },
  recette_line: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception: 'master-data T8: insert-only, only in the transaction that creates the recette (trigger).',
  },
  purchase_price: {
    kind: 'rls',
    money: true,
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'master-data T10, money since 81: insert-only versions, the owner writes (purchase_prices.write); owner and ' +
      'support read, nobody else (AC-MD-07); the cost per m³ is computed, never stored.',
  },
  selling_price: {
    kind: 'rls',
    money: true,
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'master-data T11, money since 81: insert-only versions; list prices (client_id null) written by the owner ' +
      '(selling_prices.write); per-client overrides (client_id set) by the owner only, with a reason ' +
      '(client_price_override.write, CHECK + policy: AC-MD-10); owner and support read, nobody else (AC-MD-07).',
  },
  truck: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    exception:
      'master-data T13: managers write (trucks.write); plate, capacity and status are the only updatable columns ' +
      '(column grant), the plant cannot edit a truck; code immutable (trigger).',
  },
  truck_status_log: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'master-data T13: insert-only log, written by plant, owner and partner (trucks.status.write, policy WITH CHECK; office cannot); a ' +
      'correction is a new entry. Every signed-in role reads.',
  },
  code_sequence: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'counter',
    audited: true,
    noDelete: true,
    exception:
      'master-data T3: CLT-/FRN- counters, bumped by next_code() inside the creating transaction; the pilot seed ' +
      '(belgobeton_seed login, simulation only) bumps all of them, via a policy for belgobeton_seed only.',
  },
  client: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    exception:
      'master-data T3: owner/partner/office write (archive and ICE override: owner/partner, by trigger); plant ' +
      'has no access; belgobeton_system reads and may only update phone_enc (key rotation).',
  },
  client_site: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    exception:
      'master-data T4: owner/partner/office write; plant has no access; belgobeton_system reads and may only ' +
      'update address_enc (key rotation).',
  },
  supplier: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'none',
      system: 'all',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    seed: 'insert',
    audited: true,
    noDelete: true,
    exception:
      'master-data T5: owner/partner/office write (archive: owner/partner, by trigger); plant has no access; ' +
      'belgobeton_system reads and may only update phone_enc (key rotation).',
  },
  doc_sequence: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L2: CMD-/ACH-/FA- yearly counters. Written only by public.next_doc_number() (SECURITY DEFINER; owner, ' +
      'office and the seed may call it) so the app role has no INSERT/UPDATE; read by the owner and support: office ' +
      'numbers documents but never reads the counters (blind entry, DECISIONS 81).',
  },
  sales_order: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L3: insert-only orders (a correction is a reversing row). Owner and support read; office inserts and ' +
      'cannot read back (no SELECT policy, no RETURNING); partner and plant read the view sales_order_ops, which has ' +
      'operational fields only (AC-SEC-05). Price guard, plan balance and archived-client trigger live in the database.',
  },
  payment_plan_item: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L3: insert-only plan items; Σ items = order total is a deferred constraint trigger. Same visibility as ' +
      'sales_order.',
  },
  purchase: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L20: insert-only purchases (a correction is a reversing row). Owner and support read; office inserts and cannot read back (no SELECT policy, no RETURNING); partner and plant read the view purchase_line_ops, which has quantities only. Supplier-active guard, line total and the plan balance live in the database.',
  },
  purchase_line: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L20: insert-only purchase lines (stocked components with their purchase unit, or services in words); line total = quantity x price is checked by a trigger and the sum against the purchase total at commit. Same visibility as purchase.',
  },
  purchase_plan_item: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L20: insert-only outgoing plan items; the sum equals the purchase total is a deferred constraint trigger. Same visibility as purchase.',
  },
  invoice: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L17: insert-only invoices (FA numbers from the gapless document counter; a credit note is a reversing row with its own number). Owner and support read; office inserts and cannot read back. The client name and ICE and the VAT rate are copied at creation; due date at most 120 days (law 69-21); the order, client, VAT and a load invoiced once are checked by triggers.',
  },
  invoice_line: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L17: insert-only invoice lines, one per load (volume x the order unit price, rounded once, checked by a trigger; the sum equals the invoice total HT at commit). Same visibility as invoice.',
  },
  money_account: {
    kind: 'rls',
    seed: 'insert',

    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L8: the caisse and bank accounts; owner inserts, owner and support read, nobody else (a cash position is money, DECISIONS 81). Accounts come from the pilot seed.',
  },
  opening_balance: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L8: one opening balance per account, insert-only; same visibility as money_account. Its audit rows hold the amount and are hidden from the others.',
  },
  payment_instrument: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L10: cash, cheque, LCN and transfer, incoming and outgoing. Insert-only; the current state is the last event (derived). Owner and support read; office inserts and cannot read back (blind entry, DECISIONS 81).',
  },
  instrument_event: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    blindWriters: ['office'],
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L10: append-only lifecycle events. A guard trigger enforces the legal transitions (L9 table), dates, accounts and who may do what; office may record receipt, issue and a same-day cash clearing only.',
  },
  money_movement: {
    kind: 'rls',
    seed: 'insert',
    money: true,

    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L10: signed cash movements, written only by the SECURITY DEFINER trigger on a cleared event (exactly one per instrument); the owner may insert a reversing movement (exact negation, once). Nobody else has an INSERT path.',
  },
  allocation: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L11: an instrument covers plan items; insert-only (undoing is a negated row with a reason). The owner inserts; office covers an order by code only through allocate_to_order (SECURITY DEFINER, returns a count). A guard trigger with advisory locks keeps the sums within the instrument and the item.',
  },
  ledger_opening: {
    kind: 'rls',
    seed: 'insert',

    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L33: the opening date, a singleton entered once by the owner (the app starts in the middle of activity); owner and support read.',
  },
  opening_party_balance: {
    kind: 'rls',
    seed: 'insert',
    money: true,
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L33: what a client owes us or we owe a supplier on the opening date; insert-only, owner writes, owner and support read; its audit rows hold the amount and are hidden from the others.',
  },
  delivery: {
    kind: 'rls',
    seed: 'insert',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'operations O2: truck loads with their BL number; quantities only, no money, so every signed-in role of the company reads them. Plant, owner and partner create; owner and partner cancel (a reversing row). Insert-only; guards in the database: live order, truck capacity, what is left to deliver, the recette in force.',
  },
  delivery_return: {
    kind: 'rls',
    seed: 'insert',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'operations O2: the signed-BL return, one row per delivery (A11); plant, office, owner and partner record it, a second attempt is a unique violation.',
  },
  stock_movement: {
    kind: 'rls',
    seed: 'insert',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'all',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      "operations O3: stock movements in integer base units (no money). A load writes its own, checked line by line against the recette in force and for completeness at commit; cancelling writes reversing movements; the opening stock is the owner's and the partner's. Office does not read stock.",
  },
  purchase_receipt: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'all',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L21 / operations O5: the receipt of a purchase, once (unique per purchase). No INSERT grant for the application: only public.record_receipt() writes it (owner, partner, plant; a reviewed SECURITY DEFINER function that returns the id and no amount), together with the stock movements, which the database checks against the purchase lines and for completeness at commit. Quantities only, so no money flag; office reads nothing.',
  },
  stock_threshold: {
    kind: 'rls',
    seed: 'insert',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'none',
      plant: 'all',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'operations O5: low-stock threshold per component in base units (insert-only, the latest row is in force). Owner and partner write; owner, partner, plant and support read; no money.',
  },
  company_profile: {
    kind: 'rls',
    seed: 'insert',
    read: {
      owner: 'all',
      partner: 'all',
      office: 'all',
      plant: 'all',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L29: our own legal identity (ICE, IF, RC, patente, address, RIB), versioned and insert-only: a change is a new row, the profile in force is the latest that has started. No money: every signed-in role reads it (delivery notes carry it); only the owner writes.',
  },
  correction_request: {
    kind: 'rls',
    read: {
      owner: 'all',
      partner: 'none',
      office: 'none',
      plant: 'none',
      system: 'none',
      anonymous: 'none',
      support: 'all',
    },
    force: true,
    audited: true,
    noDelete: true,
    insertOnly: true,
    exception:
      'ledger L5b: correction requests (document code + reason, no amount). Office and the owner insert; the owner ' +
      'and support read; office cannot read back (blind entry, DECISIONS 81).',
  },
  user: { kind: 'auth_only', reason: 'Better Auth account table (ADR 0001)' },
  session: { kind: 'auth_only', reason: 'Better Auth sessions (ADR 0001)' },
  account: { kind: 'auth_only', reason: 'Better Auth credentials: password hashes (ADR 0001)' },
  verification: { kind: 'auth_only', reason: 'Better Auth pending verifications (ADR 0001)' },
  twoFactor: { kind: 'auth_only', reason: 'TOTP secrets and encrypted recovery codes (ADR 0001)' },
  login_attempt: { kind: 'auth_only', reason: 'Login lockout counters, keyed hashes only' },
  totp_used_step: { kind: 'auth_only', reason: 'TOTP replay protection' },
  two_factor_pending: {
    kind: 'auth_only',
    reason: 'Staged re-enrolment (DECISIONS 77): encrypted secret and codes',
  },
} as const satisfies Record<string, RlsTable | AuthOnlyTable>;

export type TableName = keyof typeof TABLE_ACCESS;

export const RLS_TABLES = (Object.keys(TABLE_ACCESS) as TableName[]).filter(
  (
    t,
  ): t is Extract<
    TableName,
    { [K in TableName]: (typeof TABLE_ACCESS)[K]['kind'] extends 'rls' ? K : never }[TableName]
  > => TABLE_ACCESS[t].kind === 'rls',
);
