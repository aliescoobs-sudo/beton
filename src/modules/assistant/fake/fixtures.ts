import type { EntityRef } from '../domain/pseudonymizer';

/** The recorded phrasings of the evaluation set (SPEC-assistant AC-ASSIST-18): twenty per role, in French, Arabic and Darija. */
export interface Fixture {
  role: 'owner' | 'partner' | 'office' | 'plant' | 'support';
  lang: 'fr' | 'ar' | 'darija';
  question: string;
  /** The tool that should be called, or null: a question the role has no tool for (the right answer is a refusal, with no call). */
  tool: string | null;
  /** The arguments that must be there (a subset of what is called), with the question's references as the pre-pass names them. */
  args?: Record<string, unknown>;
}

/** The names the evaluation's questions use, and their codes. */
export const FIXTURE_ENTITIES: EntityRef[] = [
  { code: 'CLT-001', names: ['Entreprise Atlas BTP (fictif)', 'Atlas BTP', 'Atlas'] },
  { code: 'CLT-002', names: ['Promotion Martil Immo (fictif)', 'Martil Immo', 'Martil'] },
  { code: 'FRN-01', names: ['Ciments du Nord (fictif)', 'Ciments du Nord'] },
];

export const FIXTURE_TODAY = '2026-10-26';

const f = (
  role: Fixture['role'],
  lang: Fixture['lang'],
  question: string,
  tool: string | null,
  args?: Record<string, unknown>,
): Fixture => ({ role, lang, question, tool, ...(args ? { args } : {}) });

export const FIXTURES: Fixture[] = [
  // --- owner: reads, money reads and the five drafts
  f('owner', 'fr', "Qu'est-ce qui est sorti aujourd'hui ?", 'deliveries_today'),
  f('owner', 'fr', 'Quels camions chargent demain ?', 'deliveries_today', { date: '2026-10-27' }),
  f('owner', 'fr', 'Combien de jours de couverture en ciment ?', 'stock_and_cover'),
  f('owner', 'fr', "Qu'est-ce qu'il reste à facturer ?", 'uninvoiced_bls'),
  f('owner', 'fr', "Qu'est-ce qu'il reste à facturer pour Atlas BTP ?", 'uninvoiced_bls', {
    client: 'CLT-001',
  }),
  f('owner', 'fr', 'Quelles factures sont impayées ?', 'open_invoices'),
  f('owner', 'fr', 'Quelle est la prévision de trésorerie de la semaine ?', 'forecast'),
  f('owner', 'fr', 'Où en est la commande CMD-2026-00012 ?', 'order_chain', { order_code: 'CMD-2026-00012' }),
  f('owner', 'fr', 'Retrouve le document BL-2026-00012', 'find_document', { number: 'BL-2026-00012' }),
  f('owner', 'fr', "Où en est l'achat ACH-2026-00003 chez le fournisseur ?", 'purchase_status', {
    po_code: 'ACH-2026-00003',
  }),
  f('owner', 'fr', "Quel est l'écart de consommation du mois ?", 'consumption_variance'),
  f('owner', 'ar', 'شنو هو التحميل الجاي؟', 'next_load'),
  f('owner', 'fr', 'Prépare une commande de 20 m³ B25 pour demain pour Atlas BTP', 'plan_order', {
    client: 'CLT-001',
    type: 'B25',
    m3: 20,
    date: '2026-10-27',
  }),
  f('owner', 'fr', 'Encaisse un chèque 8451237 de 45 000 dh de Martil Immo', 'record_payment', {
    client: 'CLT-002',
    method: 'cheque',
    amount: '{{AMT_1}}',
    number: '{{NUM_2}}',
  }),
  f('owner', 'fr', 'Facture les BL BL-2026-00012 BL-2026-00013 pour Atlas BTP', 'invoice_from_bls', {
    client: 'CLT-001',
    bl_numbers: ['BL-2026-00012', 'BL-2026-00013'],
  }),
  f(
    'owner',
    'fr',
    'Passe une commande de 30 t de ciment chez Ciments du Nord à 1 450 dh',
    'create_purchase',
    { supplier: 'FRN-01', component: 'Ciment', quantity: 30, unit_price: '{{AMT_1}}' },
  ),
  f('owner', 'fr', 'Enregistre le retour du BL BL-2026-00014, refusé par le client', 'record_return', {
    bl: 'BL-2026-00014',
    reason: 'rejected_by_client',
  }),
  f('owner', 'ar', 'شنو خرج اليوم من الشاحنات؟', 'deliveries_today'),
  f('owner', 'ar', 'شحال بقى من السمنت فالسيلو؟', 'stock_and_cover'),
  f('owner', 'darija', 'ma khalsouch dyal Martil Immo', 'open_invoices', { client: 'CLT-002' }),

  // --- office: restricted reads and blind drafts; money questions have no tool
  f('office', 'fr', "Quels camions chargent aujourd'hui ?", 'deliveries_today'),
  f('office', 'fr', 'Où est mon camion ?', 'deliveries_today'),
  f('office', 'fr', 'Quel est le prochain chargement ?', 'next_load'),
  f('office', 'fr', 'Quels BL ne sont pas encore facturés ?', 'uninvoiced_bls'),
  f('office', 'fr', 'Quels BL reste-t-il à facturer pour Martil Immo ?', 'uninvoiced_bls', {
    client: 'CLT-002',
  }),
  f('office', 'fr', 'Retrouve le document BL-2026-00012', 'find_document', { number: 'BL-2026-00012' }),
  f('office', 'fr', 'Où en est la commande CMD-2026-00012 ?', 'order_chain', {
    order_code: 'CMD-2026-00012',
  }),
  f('office', 'fr', 'Prépare une commande de 7,5 m³ B25 pour demain pour Atlas BTP', 'plan_order', {
    client: 'CLT-001',
    type: 'B25',
    m3: 7.5,
    date: '2026-10-27',
  }),
  f('office', 'fr', 'Enregistre un chèque 8451237 de 45 000 dh de Martil Immo', 'record_payment', {
    client: 'CLT-002',
    method: 'cheque',
    amount: '{{AMT_1}}',
    number: '{{NUM_2}}',
  }),
  f('office', 'fr', 'Facture les BL BL-2026-00012 BL-2026-00013 pour Atlas BTP', 'invoice_from_bls', {
    client: 'CLT-001',
  }),
  f(
    'office',
    'fr',
    'Passe une commande de 30 t de ciment chez Ciments du Nord à 1 450 dh',
    'create_purchase',
    { supplier: 'FRN-01' },
  ),
  f('office', 'fr', 'Le BL BL-2026-00014 est revenu, rapporté par le chauffeur', 'record_return', {
    bl: 'BL-2026-00014',
  }),
  f('office', 'fr', 'Quelles factures sont impayées ?', null),
  f('office', 'fr', 'Quelle est la prévision de trésorerie ?', null),
  f('office', 'fr', 'Combien de jours de couverture en ciment ?', null),
  f('office', 'ar', 'أي السندات ما تفوترش بعد؟', 'uninvoiced_bls'),
  f('office', 'ar', 'شنو خرج اليوم من الشاحنات؟', 'deliveries_today'),
  f('office', 'ar', 'قلب لي على الوثيقة BL-2026-00012', 'find_document', { number: 'BL-2026-00012' }),
  f('office', 'darija', 'fin wslat la commande CMD-2026-00012', 'order_chain'),
  f('office', 'darija', 'camyon jay fin ?', 'next_load'),

  // --- plant: quantities and operations; one return; no money, no order, no invoice
  f('plant', 'fr', 'Quel est le prochain chargement ?', 'next_load'),
  f('plant', 'fr', 'Quel est le prochain chargement du camion T1 ?', 'next_load'),
  f('plant', 'fr', "Quels camions chargent aujourd'hui ?", 'deliveries_today'),
  f('plant', 'fr', 'Quels camions chargent demain ?', 'deliveries_today', { date: '2026-10-27' }),
  f('plant', 'fr', 'Où en est le silo de ciment ?', 'stock_and_cover'),
  f('plant', 'fr', 'Combien de sable reste-t-il ?', 'stock_and_cover'),
  f('plant', 'fr', 'Quelle est la couverture en gravette ?', 'stock_and_cover'),
  f('plant', 'fr', 'Où en est la commande CMD-2026-00012 ?', 'order_chain'),
  f('plant', 'fr', 'Retrouve le document BL-2026-00012', 'find_document'),
  f('plant', 'fr', "Où en est l'achat ACH-2026-00003 chez le fournisseur ?", 'purchase_status', {
    po_code: 'ACH-2026-00003',
  }),
  f('plant', 'fr', "Quel est l'écart de consommation du mois ?", 'consumption_variance'),
  f('plant', 'fr', 'Le BL BL-2026-00014 est revenu, retour de 2 m³ pour la qualité', 'record_return', {
    bl: 'BL-2026-00014',
    m3: 2,
    reason: 'quality',
  }),
  f('plant', 'fr', 'Enregistre le retour du BL BL-2026-00015, ramené trop vieux', 'record_return', {
    bl: 'BL-2026-00015',
    reason: 'too_old',
  }),
  f('plant', 'fr', 'Quelles factures sont impayées ?', null),
  f('plant', 'fr', 'Prépare une commande de 20 m³ B25 pour demain', null),
  f('plant', 'fr', 'Quelle est la prévision de trésorerie de la semaine ?', null),
  f('plant', 'ar', 'شنو هو التحميل الجاي؟', 'next_load'),
  f('plant', 'ar', 'شحال بقى من السمنت فالسيلو؟', 'stock_and_cover'),
  f('plant', 'darija', 'camyon jay fin ?', 'next_load'),
  f('plant', 'darija', 'rje3 BL-2026-00014 rfdo l3mil', 'record_return', { bl: 'BL-2026-00014' }),

  // --- partner: operations only
  f('partner', 'fr', "Quels camions chargent aujourd'hui ?", null),
  f('partner', 'fr', "Qu'est-ce qui est sorti aujourd'hui ?", null),
  f('partner', 'fr', 'Quel est le prochain chargement ?', null),
  f('partner', 'fr', 'Combien de jours de couverture en ciment ?', 'stock_and_cover'),
  f('partner', 'fr', 'Où en est le stock de sable ?', 'stock_and_cover'),
  f('partner', 'fr', 'Où en est la commande CMD-2026-00012 ?', 'order_chain'),
  f('partner', 'fr', 'Retrouve le document BL-2026-00012', 'find_document'),
  f('partner', 'fr', "Quel est l'écart de consommation du mois ?", 'consumption_variance'),
  f('partner', 'fr', "Quel est l'écart de consommation de 2026-09 ?", 'consumption_variance', {
    month: '2026-09',
  }),
  f('partner', 'fr', 'Enregistre le retour du BL BL-2026-00014, refusé par le client', 'record_return', {
    bl: 'BL-2026-00014',
    reason: 'rejected_by_client',
  }),
  f('partner', 'fr', 'Quelles factures sont impayées ?', null),
  f('partner', 'fr', "Qu'est-ce qu'il reste à facturer ?", null),
  f('partner', 'fr', 'Quelle est la prévision de trésorerie ?', null),
  f('partner', 'fr', "Où en est l'achat ACH-2026-00003 chez le fournisseur ?", null),
  f('partner', 'fr', 'Prépare une commande de 20 m³ B25 pour demain pour Atlas BTP', null),
  f('partner', 'ar', 'أي الشاحنات كتحمل اليوم؟', null),
  f('partner', 'ar', 'فين وصل استهلاك الشهر؟', 'consumption_variance'),
  f('partner', 'ar', 'شنو هو التحميل الجاي؟', null),
  f('partner', 'darija', 'camyonat li khrjo lyoum', null),
  f('partner', 'darija', 'chhal bqa mn simen f stoc ?', 'stock_and_cover'),

  // --- support: read-only, money included, no draft
  f('support', 'fr', "Qu'est-ce qui est sorti aujourd'hui ?", null),
  f('support', 'fr', 'Quel est le prochain chargement ?', null),
  f('support', 'fr', 'Combien de jours de couverture en ciment ?', 'stock_and_cover'),
  f('support', 'fr', "Qu'est-ce qu'il reste à facturer ?", 'uninvoiced_bls'),
  f('support', 'fr', "Qu'est-ce qu'il reste à facturer pour Atlas BTP ?", 'uninvoiced_bls', {
    client: 'CLT-001',
  }),
  f('support', 'fr', 'Quelles factures sont impayées ?', 'open_invoices'),
  f('support', 'fr', 'Les factures en retard de Martil Immo', 'open_invoices', { client: 'CLT-002' }),
  f('support', 'fr', 'Quelle est la prévision de trésorerie de la semaine ?', 'forecast'),
  f('support', 'fr', 'Où en est la commande CMD-2026-00012 ?', 'order_chain'),
  f('support', 'fr', 'Retrouve le document FA-2026-00004', 'find_document', { number: 'FA-2026-00004' }),
  f('support', 'fr', "Où en est l'achat ACH-2026-00003 chez le fournisseur ?", 'purchase_status'),
  f('support', 'fr', "Quel est l'écart de consommation du mois ?", 'consumption_variance'),
  f('support', 'fr', 'Facture les BL BL-2026-00012 BL-2026-00013 pour Atlas BTP', 'uninvoiced_bls'),
  f('support', 'fr', 'Encaisse un chèque 8451237 de 45 000 dh de Martil Immo', null),
  f('support', 'fr', 'Enregistre le retour du BL BL-2026-00014', null),
  f('support', 'fr', 'Prépare une commande de 20 m³ B25 pour demain pour Atlas BTP', null),
  f('support', 'ar', 'أي الفواتير مفتوحة؟', 'open_invoices'),
  f('support', 'ar', 'شنو هي توقعات الأسبوع؟', 'forecast'),
  f('support', 'darija', 'ma khalsouch dyal Atlas BTP', 'open_invoices', { client: 'CLT-001' }),
  f('support', 'darija', 'wach kayn flous had simana ?', 'forecast'),
];
