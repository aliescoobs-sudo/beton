import type { Pseudonymizer } from './pseudonymizer';

/** Stored text reaches the model only inside a delimited data block (SPEC-assistant §8). These are the caps of one tool result. */
export const RESULT_LIMITS = { rows: 50, stringChars: 80, resultChars: 6000 } as const;

// Control characters, zero-width and bidirectional controls: text that hides or reorders what a person reads.
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/**
 * A string of stored text made inert: control characters, markup, braces (a placeholder or a tool-call lookalike) and
 * code fences removed, whitespace collapsed, length capped. What is left is data a model can read and cannot obey as markup.
 */
export function sanitizeText(value: string, max: number = RESULT_LIMITS.stringChars): string {
  return value
    .replace(CONTROL_OR_BIDI, ' ')
    .replace(/[<>{}[\]`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const MONEY_KEY = /^(.*)Centimes$/;

/**
 * A tool's allow-listed output made ready for the model: strings sanitized and capped, lists capped, and every amount (a key
 * ending in `Centimes`) replaced by a placeholder under a key ending in `Amount`, with its sign as a word when negative. The figure
 * itself stays in the request's memory, to be put back by code.
 */
export function prepareForModel(value: unknown, ps: Pseudonymizer): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, RESULT_LIMITS.rows).map((v) => prepareForModel(v, ps));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const money = MONEY_KEY.exec(key);
      if (money && typeof inner === 'number') {
        out[`${money[1]}Amount`] = ps.amount(inner);
        if (inner < 0) out[`${money[1]}AmountSign`] = 'negative';
      } else {
        out[sanitizeText(key, 40)] = prepareForModel(inner, ps);
      }
    }
    return out;
  }
  return value;
}

/** The serialized block given back to the model as a tool result; cut (and said so) beyond the character cap. */
export function toDataBlock(tool: string, prepared: unknown): { text: string; truncated: boolean } {
  const json = JSON.stringify(prepared);
  const truncated = json.length > RESULT_LIMITS.resultChars;
  const body = truncated ? JSON.stringify({ truncated: true, note: 'too long, ask for less' }) : json;
  return {
    text: `<data tool="${tool.replace(/[^a-z_]/g, '')}">${body}</data>`,
    truncated,
  };
}
