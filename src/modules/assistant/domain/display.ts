import { formatCentimes } from '@/lib/money';

/**
 * A tool's result as the person sees it when the answer is the structured results themselves (the fallback of SPEC-assistant §3):
 * amounts formatted by the same function as the screens, under a key without the `Centimes` suffix. The result is what the
 * person's own role was given, so it holds no more than their screens do.
 */
export function displayResult(value: unknown, showNames: (text: string) => string): unknown {
  if (typeof value === 'string') return showNames(value);
  if (Array.isArray(value)) return value.map((v) => displayResult(v, showNames));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const money = /^(.*)Centimes$/.exec(key);
      if (money && typeof inner === 'number') out[`${money[1]}Amount`] = `${formatCentimes(inner)} MAD`;
      else out[key] = displayResult(inner, showNames);
    }
    return out;
  }
  return value;
}

/** An answer is plain text: no markup, no link, no image, no address (SPEC-assistant §8). */
export function isPlainText(text: string): boolean {
  if (text.length === 0 || text.length > 1500) return false;
  if (/<\/?[a-zA-Z!]/.test(text)) return false;
  if (/\]\(|!\[|https?:\/\/|www\./i.test(text)) return false;
  // A code fence or a tool-call lookalike.
  if (/```|<tool|\bfunction_call\b/i.test(text)) return false;
  return true;
}
