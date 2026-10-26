/**
 * The shared test database holds products, components and lines that other suites named with random strings (a run of six digits
 * is possible, and it is a leak by rule). Those labels are business words, not personal data; the leak checks of the assistant look at
 * everything else, so they blank these fields first.
 */
const LABEL_KEYS = new Set(['product', 'name', 'nameFr', 'nameAr', 'label']);

export function withoutFixtureLabels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFixtureLabels);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        LABEL_KEYS.has(k) && typeof v === 'string' ? 'x' : withoutFixtureLabels(v),
      ]),
    );
  return value;
}
