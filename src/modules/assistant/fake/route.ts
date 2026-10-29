import { addDaysIso } from '@/modules/ledger';
import { readQuestion, type Q } from './question';

export interface RoutedCall {
  name: string;
  args: Record<string, unknown>;
}

/** What the scripted provider sees of the world besides the question: the business date, to say "demain". */
export interface RouteEnv {
  today: string;
}

// Words, in French, in Arabic and in Darija (Latin or Arabic letters), that make an intent. Normalized when compared, so accents,
// diacritics and the forms of alef, yeh and teh-marbuta do not matter. A scripted stand-in for a model, not a model: it exists so the
// demo and the tests need no network, and every answer it makes goes through the same checks as a real model's.
const W = {
  invoice: [
    'facture',
    'facturer',
    'facturés',
    'نفوتر',
    'فوتر',
    'فاتورة',
    'نفاكتر',
    'fakturi',
    'nfaktouri',
    'bill',
  ],
  notInvoiced: [
    'pas encore facture',
    'non facture',
    'a facturer',
    'à facturer',
    'reste a facturer',
    'pas facture',
    'ما تفوترش',
    'ما تفاكتراتش',
    'غير مفوتر',
    'للفوترة',
    'باش نفوتر',
    'machi mfaktar',
    'mazal ma tfaktarch',
    'ghir mfaktar',
  ],
  openInvoices: [
    'impaye',
    'impayes',
    'ouvertes',
    'echue',
    'echues',
    'en retard',
    'pas paye',
    'non payes',
    'restent a payer',
    'غير مؤداة',
    'ما خلصوش',
    'ماخلصوش',
    'متاخرة',
    'ديون',
    'الفواتير المفتوحة',
    'مفتوحة',
    'فواتير',
    'الفواتير',
    'mazal ma khalsouch',
    'ma khalsouch',
    'impayé',
  ],
  forecast: [
    'prevision',
    'previsions',
    'tresorerie',
    'cash',
    'semaine',
    'trésorerie',
    'التوقعات',
    'السيولة',
    'الكاش',
    'الاسبوع',
    'سيمانة',
    'semaine prochaine',
    'flous',
    'lflous',
  ],
  stock: [
    'ciment',
    'sable',
    'gravette',
    'stock',
    'couverture',
    'silo',
    'autonomie',
    'jours de',
    'إسمنت',
    'اسمنت',
    'سمنت',
    'رمل',
    'مخزون',
    'السيلو',
    'سيلو',
    'simen',
    'stoc',
    'commander du',
    'reapprovisionner',
    'réappro',
  ],
  nextLoad: [
    'prochain chargement',
    'prochaine charge',
    'prochain camion',
    'chargement suivant',
    'prochaine rotation',
    'prochain a charger',
    'prochain à charger',
    'الشحنة الجاية',
    'الشاحنة الجاية',
    'التحميل الجاي',
    'التحميل الموالي',
    'شحنة الجاية',
    'chargement jay',
    'camyon jay',
    'prochain',
  ],
  trucks: [
    'camion',
    'camions',
    'rotation',
    'rotations',
    'livraison',
    'livraisons',
    'livre',
    'charge',
    'chargent',
    'sorti',
    'sortis',
    'partis',
    'الشاحنات',
    'شاحنة',
    'توصيل',
    'تسليم',
    'خرجو',
    'خرج',
    'تحميل',
    'camyon',
    'camyonat',
    'tawsil',
    'khrjo',
    'kharjin',
  ],
  consumption: [
    'consommation',
    'ecart',
    'ecarts',
    'theorique',
    'écart',
    'استهلاك',
    'فرق',
    'الفرق',
    'تيوريك',
    'sta3mal',
    'consommé',
  ],
  purchase: [
    'fournisseur',
    'achat',
    'achats',
    'reception',
    'reçu',
    'recu',
    'bon de commande',
    'المورد',
    'الموردين',
    'شراء',
    'مشتريات',
    'استلام',
    'الطلبية',
    'mawrid',
    'lmorid',
    'fournisseurs',
  ],
  find: [
    'retrouve',
    'cherche',
    'trouve',
    'document',
    'ou est le',
    'où est le',
    'لقى',
    'قلب',
    'قلب لي',
    'لقا',
    'find',
    'lqa',
    'qelleb',
    'wach kayn',
  ],
  chain: [
    'ou en est',
    'où en est',
    'etape',
    'étape',
    'avancement',
    'suivi de la commande',
    'وين وصلات',
    'فين وصلات',
    'وصلات الكوماند',
    'مراحل',
    'fin wslat',
    'fin wsal',
  ],
  returnWords: [
    'retour',
    'refuse',
    'refusé',
    'ramene',
    'ramené',
    'rapporte',
    'rapporté',
    'rejete',
    'رجع',
    'رجعو',
    'مرفوض',
    'رفض',
    'رفضو',
    'رجّع',
    'rje3',
    'rja3',
    'rfdo',
    'retourné',
    'revenu',
  ],
  payment: [
    'encaisse',
    'encaissement',
    'paiement',
    'paye',
    'cheque',
    'chèque',
    'virement',
    'especes',
    'espèces',
    'lcn',
    'traite',
    'reçu un',
    'دفع',
    'خلص',
    'شيك',
    'كاش',
    'تحويل',
    'خلصني',
    'تقبض',
    'khlas',
    'chik',
    'cheek',
  ],
  buy: [
    'achat',
    'achete',
    'acheter',
    'commander',
    'passe une commande',
    'commande fournisseur',
    'نشري',
    'شراء',
    'طلبية',
    'نطلب',
    'nchri',
    'ntlob',
    'commande chez',
  ],
  order: [
    'commande',
    'prepare',
    'prépare',
    'planifie',
    'programme',
    'طلبية',
    'كوماند',
    'حضر',
    'نحضر',
    'كوموند',
    'komand',
    'ta7dir',
    'preparer',
  ],
  tomorrow: ['demain', 'غدا', 'غدّا', 'ghda', 'ghadda'],
  afterTomorrow: ['apres demain', 'après-demain', 'après demain', 'بعد غد', 'ba3d ghda'],
  today: ['aujourd', 'ce jour', 'اليوم', 'lyoum', 'lyom'],
} as const;

const component = (q: Q): string | null =>
  q.has('ciment', 'إسمنت', 'اسمنت', 'سمنت', 'simen')
    ? 'Ciment'
    : q.has('sable', 'رمل', 'ramel')
      ? 'Sable'
      : q.has('gravette 8/15', 'حصى 8/15')
        ? 'Gravette 8/15'
        : q.has('gravette 15/25', 'حصى 15/25')
          ? 'Gravette 15/25'
          : q.has('adjuvant', 'مادة مضافة')
            ? 'Adjuvant'
            : null;

const dateOf = (q: Q, env: RouteEnv): string => {
  if (q.isoDates[0]) return q.isoDates[0];
  if (q.has(...W.afterTomorrow)) return addDaysIso(env.today, 2);
  if (q.has(...W.tomorrow)) return addDaysIso(env.today, 1);
  if (q.has(...W.today)) return env.today;
  return addDaysIso(env.today, 1);
};

/** The day a question asks about, when it is not today: an ISO date, "demain", "après-demain". */
const dayArg = (q: Q, env: RouteEnv): Record<string, unknown> =>
  q.isoDates[0]
    ? { date: q.isoDates[0] }
    : q.has(...W.afterTomorrow)
      ? { date: addDaysIso(env.today, 2) }
      : q.has(...W.tomorrow)
        ? { date: addDaysIso(env.today, 1) }
        : {};

const paymentMethod = (q: Q): 'cash' | 'cheque' | 'lcn' | 'transfer' =>
  q.has('lcn', 'traite')
    ? 'lcn'
    : q.has('virement', 'تحويل')
      ? 'transfer'
      : q.has('especes', 'espèces', 'كاش', 'cash')
        ? 'cash'
        : 'cheque';

const returnReason = (q: Q): string =>
  q.has('qualite', 'qualité', 'جودة')
    ? 'quality'
    : q.has('trop vieux', 'trop ancien', 'فات وقته', 'قديم')
      ? 'too_old'
      : q.has('inutilise', 'inutilisé', 'pas utilise', 'ما تخدمش')
        ? 'returned_unused'
        : 'rejected_by_client';

/**
 * The tool a question calls for, with its arguments, among the tools the person was offered, or none. Drafts first (they need
 * their verb and their data), then the specific reads, then the topical ones. The arguments come from the codes and references
 * of the masked question only.
 */
export function routeQuestion(text: string, offered: readonly string[], env: RouteEnv): RoutedCall | null {
  const q = readQuestion(text);
  const can = (name: string) => offered.includes(name);
  const call = (name: string, args: Record<string, unknown> = {}): RoutedCall | null =>
    can(name) ? { name, args } : null;
  const client = q.clients[0];

  // Drafts. A role that has the verb's draft gets it; one that has not is refused (null), except for "facture ces BL", which a role
  // that only reads still gets answered as the list of what is to invoice.
  if (
    client &&
    q.bls.length > 0 &&
    q.has(...W.invoice) &&
    !q.has(...W.returnWords) &&
    can('invoice_from_bls')
  )
    return call('invoice_from_bls', { client, bl_numbers: [...new Set(q.bls)] });
  if (q.bls.length > 0 && q.has(...W.returnWords))
    return call('record_return', {
      bl: q.bls[0],
      ...(q.m3 !== null ? { m3: q.m3 } : {}),
      reason: returnReason(q),
    });
  if (client && q.amounts.length > 0 && q.has(...W.payment))
    return call('record_payment', {
      client,
      method: paymentMethod(q),
      amount: q.amounts[0],
      ...(q.numbers[0] ? { number: q.numbers[0] } : {}),
      ...(paymentMethod(q) === 'cheque' || paymentMethod(q) === 'lcn'
        ? { written_date: q.isoDates[0] ?? env.today }
        : {}),
      ...(q.orders[0] ? { order_code: q.orders[0] } : {}),
    });
  if (q.suppliers[0] && q.has(...W.buy) && component(q) && (q.tonnes !== null || q.m3 !== null))
    return call('create_purchase', {
      supplier: q.suppliers[0],
      component: component(q),
      quantity: q.tonnes ?? q.m3,
      ...(component(q) === 'Ciment' ? { unit: 't' } : {}),
      ...(q.amounts[0] ? { unit_price: q.amounts[0] } : {}),
    });
  if (client && q.m3 !== null && q.types[0] && q.has(...W.order))
    return call('plan_order', {
      client,
      type: q.types[0],
      m3: q.m3,
      date: dateOf(q, env),
      ...(q.sites[0] ? { site: q.sites[0] } : {}),
      ...(q.has('50', 'avance', 'سلف') ? { plan: 'advance50' } : {}),
      ...(q.amounts[0] ? { price: q.amounts[0] } : {}),
    });

  // The verb of a draft the role does not have: a refusal, not a read of something else.
  if (q.bls.length > 0 && q.has(...W.returnWords)) return null;
  if (client && q.amounts.length > 0 && q.has(...W.payment)) return null;
  if (q.suppliers[0] && q.has(...W.buy) && component(q)) return null;
  if (client && q.m3 !== null && q.types[0] && q.has(...W.order)) return null;

  // Specific reads.
  if (q.pos[0] && !q.has(...W.find)) return call('purchase_status', { po_code: q.pos[0] });
  if (q.documents[0] && q.has(...W.find)) return call('find_document', { number: q.documents[0] });
  if (q.orders[0]) return call('order_chain', { order_code: q.orders[0] });
  if (q.documents[0] && !q.has(...W.invoice)) return call('find_document', { number: q.documents[0] });
  if (
    q.has(...W.nextLoad) &&
    q.has(...W.trucks, 'chargement', 'charge', 'شحنة', 'تحميل', 'rotation', 'prochain')
  )
    return call('next_load', { ...(client ? { client } : {}) });
  if (q.has(...W.consumption))
    return call('consumption_variance', { ...(q.month ? { month: q.month } : {}) });
  if (
    q.has(...W.notInvoiced) ||
    (q.has(...W.invoice) && q.has('bl', 'livraison', 'livraisons', 'بون', 'سندات'))
  )
    return call('uninvoiced_bls', { ...(client ? { client } : {}) });
  if (q.has(...W.openInvoices)) return call('open_invoices', { ...(client ? { client } : {}) });
  if (q.has(...W.forecast)) return call('forecast');
  if (q.has(...W.purchase) && !q.has(...W.stock.filter((w) => w !== 'commander du')))
    return call('purchase_status', { ...(q.pos[0] ? { po_code: q.pos[0] } : {}) });
  if (q.has(...W.stock)) return call('stock_and_cover');
  if (q.has(...W.trucks)) return call('deliveries_today', dayArg(q, env));
  if (q.has(...W.purchase)) return call('purchase_status', { ...(q.pos[0] ? { po_code: q.pos[0] } : {}) });
  return null;
}
