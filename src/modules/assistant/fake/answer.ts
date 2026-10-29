export type Lang = 'fr' | 'ar';

interface ToolMessage {
  name: string;
  data: Record<string, unknown>;
}

/** The tool results of the turn, read back from the data blocks the model was given. */
export function readToolMessages(
  messages: { role: string; name?: string; content: string }[],
): ToolMessage[] {
  const out: ToolMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    const match = /^<data tool="([a-z_]*)">([\s\S]*)<\/data>$/.exec(m.content);
    if (!match) continue;
    try {
      out.push({ name: match[1] as string, data: JSON.parse(match[2] as string) as Record<string, unknown> });
    } catch {
      continue;
    }
  }
  return out;
}

const STEP: Record<Lang, Record<string, string>> = {
  fr: {
    planned: 'prévu',
    loaded: 'chargé',
    departed: 'parti',
    arrived: 'arrivé',
    unloading_started: 'déchargement commencé',
    unloading_finished: 'déchargé',
    back: 'rentré',
  },
  ar: {
    planned: 'مبرمج',
    loaded: 'محمّل',
    departed: 'غادر',
    arrived: 'وصل',
    unloading_started: 'بدأ التفريغ',
    unloading_finished: 'تم التفريغ',
    back: 'رجع',
  },
};

const KIND: Record<Lang, Record<string, string>> = {
  fr: {
    bl: 'BL',
    order: 'commande',
    invoice: 'facture',
    quote: 'devis',
    purchase: 'achat',
    supplier_invoice: 'facture fournisseur',
    avoir: 'avoir',
    payment: 'paiement',
  },
  ar: {
    bl: 'سند تسليم',
    order: 'طلبية',
    invoice: 'فاتورة',
    quote: 'عرض سعر',
    purchase: 'شراء',
    supplier_invoice: 'فاتورة مورّد',
    avoir: 'إشعار دائن',
    payment: 'أداء',
  },
};

const PAID: Record<Lang, Record<string, string>> = {
  fr: { unpaid: 'non payée', partial: 'partiellement payée', paid: 'payée' },
  ar: { unpaid: 'غير مؤداة', partial: 'مؤداة جزئيا', paid: 'مؤداة' },
};

const DRAFT: Record<Lang, Record<string, string>> = {
  fr: {
    plan_order: 'commande',
    record_payment: 'paiement',
    create_purchase: 'achat',
    record_return: 'retour',
    invoice_from_bls: 'facture',
  },
  ar: {
    plan_order: 'طلبية',
    record_payment: 'أداء',
    create_purchase: 'شراء',
    record_return: 'إرجاع',
    invoice_from_bls: 'فاتورة',
  },
};

const REASON: Record<Lang, Record<string, string>> = {
  fr: {
    NEEDS_AMOUNT: 'Il me manque le montant que vous avez indiqué.',
    NOT_FOUND: 'Je ne trouve pas ce client, ce produit, ce fournisseur ou ce document.',
    INCOMPLETE: 'Il manque le numéro ou la date écrite du chèque.',
    STALE: 'Ces BL ne sont pas ou plus à facturer pour ce client.',
    NOT_ALLOWED: "Cette demande n'est pas permise pour votre profil.",
    NEEDS_PRICE: "Je n'ai pas de prix : indiquez-le dans votre demande.",
    NEEDS_UNIT: "Précisez l'unité d'achat.",
    ALREADY_RECORDED: 'Un retour est déjà enregistré pour ce BL.',
    OVER_LOAD: 'La quantité dépasse celle du chargement.',
    INVALID: 'La demande est incomplète ou invalide.',
  },
  ar: {
    NEEDS_AMOUNT: 'ينقصني المبلغ الذي ذكرتموه.',
    NOT_FOUND: 'لا أجد هذا العميل أو المنتج أو المورد أو الوثيقة.',
    INCOMPLETE: 'ينقص رقم الشيك أو تاريخه المكتوب.',
    STALE: 'هذه السندات غير قابلة للفوترة لهذا العميل أو لم تعد كذلك.',
    NOT_ALLOWED: 'هذا الطلب غير مسموح به لصفتكم.',
    NEEDS_PRICE: 'لا أملك سعرا: اذكروه في طلبكم.',
    NEEDS_UNIT: 'حدّدوا وحدة الشراء.',
    ALREADY_RECORDED: 'تم تسجيل إرجاع لهذا السند من قبل.',
    OVER_LOAD: 'الكمية تفوق كمية الشحنة.',
    INVALID: 'الطلب ناقص أو غير صالح.',
  },
};

const num = (v: unknown): string => (typeof v === 'number' ? String(v) : String(v ?? ''));
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const amount = (o: Record<string, unknown>, key: string, lang: Lang): string =>
  `${str(o[`${key}Amount`])}${o[`${key}AmountSign`] === 'negative' ? (lang === 'ar' ? ' (سالب)' : ' (négatif)') : ''}`;

function one(t: ToolMessage, lang: Lang): string {
  const d = t.data;
  const fr = lang === 'fr';
  if (typeof d.error === 'string') {
    if (typeof d.reason === 'string') return (REASON[lang][d.reason] ?? REASON[lang].INVALID) as string;
    return fr ? 'Je ne peux pas répondre à cela avec vos droits.' : 'لا يمكنني الجواب عن هذا بصلاحياتكم.';
  }
  switch (t.name) {
    case 'deliveries_today': {
      const rows = arr(d.rotations);
      if (rows.length === 0)
        return fr
          ? `Aucune rotation prévue le ${str(d.date)}.`
          : `لا توجد رحلات مبرمجة بتاريخ ${str(d.date)}.`;
      const lines = rows
        .slice(0, 6)
        .map((r) =>
          fr
            ? `camion ${str(r.truck)} à ${str(r.loadTime)}, ${num(r.m3)} m³${r.client ? ` pour ${str(r.client)}` : ''}${r.product ? ` (${str(r.product)})` : ''}, ${STEP.fr[str(r.step)] ?? ''}${r.bl ? `, BL ${str(r.bl)}` : ''}`
            : `الشاحنة ${str(r.truck)} على الساعة ${str(r.loadTime)}، ${num(r.m3)} م³${r.client ? ` للعميل ${str(r.client)}` : ''}${r.product ? ` (${str(r.product)})` : ''}، ${STEP.ar[str(r.step)] ?? ''}${r.bl ? `، سند ${str(r.bl)}` : ''}`,
        );
      return fr
        ? `${num(d.count)} rotation(s) le ${str(d.date)} : ${lines.join(' ; ')}.`
        : `${num(d.count)} رحلة بتاريخ ${str(d.date)}: ${lines.join(' ؛ ')}.`;
    }
    case 'next_load': {
      const r = d.rotation as Record<string, unknown> | null;
      if (!d.found || !r) return fr ? "Aucun chargement à venir aujourd'hui." : 'لا توجد شحنة قادمة اليوم.';
      return fr
        ? `Prochain chargement : camion ${str(r.truck)} à ${str(r.loadTime)}, ${num(r.m3)} m³${r.product ? ` de ${str(r.product)}` : ''}${r.client ? ` pour ${str(r.client)}` : ''}.`
        : `التحميل القادم: الشاحنة ${str(r.truck)} على الساعة ${str(r.loadTime)}، ${num(r.m3)} م³${r.product ? ` من ${str(r.product)}` : ''}${r.client ? ` للعميل ${str(r.client)}` : ''}.`;
    }
    case 'stock_and_cover': {
      const lines = arr(d.components)
        .slice(0, 5)
        .map((c) => {
          const name = fr ? str(c.nameFr) : str(c.nameAr);
          const cover =
            c.coverDays === null
              ? fr
                ? 'pas de besoin sur la période'
                : 'لا حاجة خلال الفترة'
              : fr
                ? `couverture ${num(c.coverDays)} jours`
                : `تغطية ${num(c.coverDays)} أيام`;
          const order =
            c.needsOrder && c.orderBy
              ? fr
                ? `, à commander avant le ${str(c.orderBy)}`
                : `، يجب الطلب قبل ${str(c.orderBy)}`
              : '';
          return `${name} : ${num(c.level)} ${str(c.unit)}, ${cover}${order}`;
        });
      return lines.length === 0
        ? fr
          ? 'Aucun composant en stock.'
          : 'لا توجد مكونات في المخزون.'
        : `${lines.join(fr ? ' ; ' : ' ؛ ')}.`;
    }
    case 'uninvoiced_bls': {
      const clients = arr(d.clients);
      if (clients.length === 0) return fr ? 'Rien à facturer pour le moment.' : 'لا شيء للفوترة حاليا.';
      const lines = clients.slice(0, 4).map((c) => {
        const bls = arr(c.bls)
          .slice(0, 5)
          .map((b) => str(b.bl))
          .join(', ');
        const ttc = c.ttcAmount
          ? fr
            ? `, soit ${str(c.ttcAmount)} TTC`
            : `، أي ${str(c.ttcAmount)} مع الضريبة`
          : '';
        return fr
          ? `${str(c.client)} : ${num(c.blCount)} BL, ${num(c.totalM3)} m³ (${bls})${ttc}`
          : `${str(c.client)}: ${num(c.blCount)} سند، ${num(c.totalM3)} م³ (${bls})${ttc}`;
      });
      return fr ? `À facturer : ${lines.join(' ; ')}.` : `للفوترة: ${lines.join(' ؛ ')}.`;
    }
    case 'open_invoices': {
      const invoices = arr(d.invoices);
      if (invoices.length === 0) return fr ? 'Aucune facture ouverte.' : 'لا توجد فواتير مفتوحة.';
      const lines = invoices
        .slice(0, 4)
        .map((i) =>
          fr
            ? `${str(i.number)}${i.client ? ` (${str(i.client)})` : ''} : reste ${amount(i, 'open', fr ? 'fr' : 'ar')}, échéance ${str(i.dueDate)}${i.overdue ? `, en retard de ${num(i.daysOverdue)} jours` : ''}`
            : `${str(i.number)}${i.client ? ` (${str(i.client)})` : ''}: المتبقي ${amount(i, 'open', 'ar')}، الاستحقاق ${str(i.dueDate)}${i.overdue ? `، متأخرة بـ ${num(i.daysOverdue)} يوما` : ''}`,
        );
      return fr
        ? `${num(d.count)} facture(s) ouverte(s), ${amount(d, 'openTotal', 'fr')} à encaisser : ${lines.join(' ; ')}.`
        : `${num(d.count)} فاتورة مفتوحة، ${amount(d, 'openTotal', 'ar')} للتحصيل: ${lines.join(' ؛ ')}.`;
    }
    case 'forecast': {
      const black = d.black as Record<string, unknown> | null;
      const lowest = d.lowest as Record<string, unknown> | null;
      const parts = [
        fr
          ? `Trésorerie aujourd'hui : ${amount(d, 'cashToday', 'fr')}.`
          : `السيولة اليوم: ${amount(d, 'cashToday', 'ar')}.`,
        black
          ? fr
            ? `Jour critique le ${str(black.date)} (${str(black.severity)}), il manquerait ${amount(black, 'shortfall', 'fr')}.`
            : `يوم حرج بتاريخ ${str(black.date)} (${str(black.severity)})، سينقص ${amount(black, 'shortfall', 'ar')}.`
          : fr
            ? 'Aucun jour critique sur la période.'
            : 'لا يوجد يوم حرج خلال الفترة.',
        lowest
          ? fr
            ? `Point bas le ${str(lowest.date)} : ${amount(lowest, 'balance', 'fr')}.`
            : `أدنى رصيد بتاريخ ${str(lowest.date)}: ${amount(lowest, 'balance', 'ar')}.`
          : '',
        fr ? `${num(d.alertCount)} alerte(s).` : `${num(d.alertCount)} تنبيه.`,
      ];
      return parts.filter(Boolean).join(' ');
    }
    case 'order_chain': {
      const o = d.order as Record<string, unknown> | null;
      if (!d.found || !o) return fr ? 'Commande introuvable.' : 'الطلبية غير موجودة.';
      const s = o.stages as Record<string, unknown>;
      const paid =
        typeof s.paid === 'string' ? (fr ? `, ${PAID.fr[s.paid] ?? ''}` : `، ${PAID.ar[s.paid] ?? ''}`) : '';
      return fr
        ? `${str(o.code)} (${str(o.client)}, ${str(o.product)}) : commandé ${num(s.orderedM3)} m³, planifié ${num(s.plannedM3)}, chargé ${num(s.loadedM3)}, livré ${num(s.deliveredM3)}, facturé ${num(s.invoicedM3)}${paid}${o.cancelled ? ', annulée' : ''}.`
        : `${str(o.code)} (${str(o.client)}، ${str(o.product)}): المطلوب ${num(s.orderedM3)} م³، المبرمج ${num(s.plannedM3)}، المحمّل ${num(s.loadedM3)}، المسلّم ${num(s.deliveredM3)}، المفوتر ${num(s.invoicedM3)}${paid}${o.cancelled ? '، ملغاة' : ''}.`;
    }
    case 'find_document': {
      const docs = arr(d.documents);
      if (docs.length === 0)
        return fr ? 'Aucun document trouvé avec ce numéro.' : 'لم يتم العثور على أي وثيقة بهذا الرقم.';
      const list = docs
        .slice(0, 6)
        .map((x) => `${KIND[lang][str(x.kind)] ?? str(x.kind)} ${x.number ? str(x.number) : ''}`.trim())
        .join(fr ? ' ; ' : ' ؛ ');
      return fr ? `${num(d.count)} document(s) : ${list}.` : `${num(d.count)} وثيقة: ${list}.`;
    }
    case 'purchase_status': {
      const ps = arr(d.purchases);
      if (ps.length === 0)
        return fr ? 'Aucune commande fournisseur trouvée.' : 'لم يتم العثور على أي طلبية مورّد.';
      const lines = ps.slice(0, 4).map((p) => {
        const lines2 = arr(p.lines)
          .slice(0, 3)
          .map((l) =>
            fr
              ? `${str(l.name)} ${num(l.receivedQty)} reçu sur ${num(l.orderedQty)} ${str(l.unit)}`
              : `${str(l.name)} استلم ${num(l.receivedQty)} من ${num(l.orderedQty)} ${str(l.unit)}`,
          )
          .join(', ');
        const inv = arr(p.invoices)
          .map((i) =>
            fr
              ? `facture ${str(i.code)} ${num(i.gapLines) === '0' ? 'conforme' : `avec ${num(i.gapLines)} écart(s)`}`
              : `فاتورة ${str(i.code)} ${num(i.gapLines) === '0' ? 'مطابقة' : `بها ${num(i.gapLines)} فروق`}`,
          )
          .join(', ');
        return `${str(p.code)} (${str(p.supplier)}) ${str(p.status)} : ${lines2}${inv ? `, ${inv}` : ''}`;
      });
      return `${lines.join(fr ? ' ; ' : ' ؛ ')}.`;
    }
    case 'consumption_variance': {
      const comps = arr(d.components);
      const flagged = comps.filter((c) => c.flagged);
      const head = fr
        ? `Consommation de ${str(d.month)} : ${num(d.producedM3)} m³ produits.`
        : `استهلاك ${str(d.month)}: ${num(d.producedM3)} م³ منتجة.`;
      if (flagged.length === 0)
        return `${head} ${fr ? 'Aucun écart au-delà de la tolérance.' : 'لا فرق يتجاوز الحد المسموح.'}`;
      const list = flagged
        .slice(0, 4)
        .map((c) =>
          fr
            ? `${str(c.nameFr)} écart ${num(c.variance)} ${str(c.unit)}`
            : `${str(c.nameAr)} فرق ${num(c.variance)} ${str(c.unit)}`,
        )
        .join(fr ? ' ; ' : ' ؛ ');
      return `${head} ${fr ? 'Écarts :' : 'الفروق:'} ${list}.`;
    }
    default:
      if (d.drafted === true)
        return fr
          ? `J'ai préparé un brouillon de ${DRAFT.fr[str(d.action)] ?? 'document'} : vérifiez la carte, puis confirmez ou refusez. Rien n'est enregistré avant.`
          : `حضّرت مسودة ${DRAFT.ar[str(d.action)] ?? 'وثيقة'}: راجعوا البطاقة ثم أكّدوا أو ارفضوا. لا يسجَّل شيء قبل ذلك.`;
      return fr ? 'Voir les résultats ci-dessous.' : 'انظروا النتائج أدناه.';
  }
}

/** The answer, from the tool results alone: what the tools returned, in a sentence, with their numbers and placeholders as they are. */
export function composeAnswer(tools: ToolMessage[], lang: Lang): string {
  return tools.map((t) => one(t, lang)).join(' ');
}

export const NO_TOOL: Record<Lang, string> = {
  fr: "Je ne peux pas répondre à cette question ici avec vos droits. Utilisez l'écran correspondant.",
  ar: 'لا يمكنني الجواب عن هذا السؤال هنا بصلاحياتكم. استعملوا الشاشة المناسبة.',
};
