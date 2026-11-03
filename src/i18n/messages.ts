type Tree = { [key: string]: Tree | string | number | boolean | null | Tree[] | string[] };

/** Overlays `over` on `base`, key by key: an untranslated Darija message is the Arabic one, never a missing key. */
export function overlay(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      b !== null &&
      typeof b === 'object' &&
      !Array.isArray(b)
        ? overlay(b as Tree, v as Tree)
        : v;
  }
  return out;
}
