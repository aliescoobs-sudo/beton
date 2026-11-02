/**
 * §16.4 (REQUIREMENTS-V1): the assistant answers about recorded operations only. A question where the person picks an amount
 * and asks whether it works ("can we pay 50k?", then "and 40k?") would let them find a balance by bisection, so it is
 * refused, for every role, before any gate, tool or model. Deterministic, no model.
 */

// Codes and numbers that are identifiers, not amounts: CHQ-000123, BL-2026-00012, CLT-014, 2026-11-02, phone-like runs.
const IDENTIFIERS =
  /\b[A-Za-z]{1,6}-[A-Za-z0-9-]*\d[A-Za-z0-9-]*\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g;

const MAGNITUDE =
  '(?:k|m|mille|milles|million|millions|millier|mad|dh|dhs|dirhams?|درهم|دراهم|دريال|ألف|الف|مليون|مليار|مي?ة|ريال)';
// "50k", "50 000 dh", "50.000", "50,000 MAD", "ألف درهم", "40 mille"
const WITH_MARKER = new RegExp(
  `(?:\\d[\\d\\s.,\\u202f\\u00a0]*\\s*${MAGNITUDE}(?![\\p{L}])|${MAGNITUDE}\\s*\\d)`,
  'iu',
);
const BIG_PLAIN = /(?<![\d.,])\d{1,3}(?:[\s.,  ]\d{3})+(?![\d])|(?<![\d.,])\d{5,}(?![\d])/;

const ABILITY = new RegExp(
  [
    // English
    '\\b(?:can|could|should|shall|will|would|may|afford|enough|cover|covers|covered|short|ok to|okay to|is it ok|is it fine|do we have)\\b',
    // French
    '\\b(?:peut|peux|peuvent|pouvons|pourrait|pourra|pourrons|devons|doit|faut|suffit|suffisant|assez|couvre|couvrir|reste|est-ce que|est ce que|on a de quoi|si on)\\b',
    // Arabic / Darija
    '(?:هل|واش|نقدر|نقدرو|يمكن|ممكن|كاف|كافي|يكفي|كيكفي|كيكفيش|نخلص|نخلصو|ندفع|ندفعو|نسدد|عندنا|باقي|شحال)',
  ].join('|'),
  'iu',
);
const FRAGMENT_START = /^\s*(?:and|et|ou|or|what about|et si|ولا|والا|وإذا|و)(?=[\s\d])/iu;

export interface ChosenAmountInput {
  question: string;
  /** The questions asked before in this conversation, oldest first. */
  previous?: string[];
}

function stripped(text: string): string {
  return text.replace(IDENTIFIERS, ' ');
}

/** Whether the text names an amount of money (with a unit or magnitude, or a long number), codes and dates left out. */
export function mentionsAmount(text: string): boolean {
  const t = stripped(text);
  return WITH_MARKER.test(t) || BIG_PLAIN.test(t);
}

/** True when the question must be refused: an amount the person picked, asked about as a possibility, or as a follow-up fragment. */
export function isChosenAmountQuestion(input: ChosenAmountInput): boolean {
  const q = input.question.trim();
  if (!mentionsAmount(q)) return false;
  if (ABILITY.test(stripped(q))) return true;
  // "and 40k?" : a short follow-up that is mostly an amount, after another question
  const words = q.split(/\s+/).filter(Boolean).length;
  return (input.previous?.length ?? 0) > 0 && words <= 6 && (FRAGMENT_START.test(q) || /[?؟]\s*$/.test(q));
}
