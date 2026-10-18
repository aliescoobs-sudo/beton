/**
 * Asserts a response never exposes the given fields (AC-SEC-05): searches object keys at any depth, or, for rendered
 * HTML, `data-field="…"` attributes (UI cells for sensitive values carry one).
 */
export function expectNoFields(value: unknown, fields: readonly string[]): void {
  const found = new Set<string>();
  const forbidden = new Set(fields);

  const walk = (node: unknown) => {
    if (typeof node === 'string') {
      for (const f of fields) if (node.includes(`data-field="${f}"`)) found.add(f);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      for (const [key, inner] of Object.entries(node)) {
        if (forbidden.has(key)) found.add(key);
        walk(inner);
      }
    }
  };
  walk(value);
  if (found.size) throw new Error(`Response exposes forbidden fields: ${[...found].join(', ')}`);
}
