import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The two bundled fonts are the unmodified upstream files named in the FLUX trace package README (section 7): their SHA-256 is checked
// against the values written there, and the licence texts stay next to them. Inter (Latin, numbers, units) and Noto Naskh Arabic (Arabic).
const readme = readFileSync('docs/brand/KAYAS-FLUX-TRACE-README.md', 'utf8');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const expected = (name: string) =>
  new RegExp(`\\| ${name} \\|[^|]*\\| \`([0-9a-f]{64})\` \\|`).exec(readme)?.[1];

describe('bundled fonts', () => {
  it.each([
    ['kayas-font-latin-variable.ttf', '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031'],
    ['kayas-font-arabic-variable.ttf', '67b5a525a661b607971fbd3f96a81b89d3a768e74534fca84f18ac97e6fab72f'],
  ])('%s matches the SHA-256 in the package README', (name, pinned) => {
    expect(expected(name)).toBe(pinned);
    expect(sha(`public/fonts/${name}`)).toBe(pinned);
  });

  it('the licence texts ship next to the fonts and the third-party notice names both families', () => {
    for (const f of ['latin', 'arabic']) {
      const lic = readFileSync(`public/fonts/kayas-font-${f}-license.txt`, 'utf8');
      expect(lic).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i);
      expect(lic).toMatch(/Copyright/);
    }
    const notices = readFileSync('THIRD_PARTY_NOTICES.md', 'utf8');
    expect(notices).toMatch(/Inter/);
    expect(notices).toMatch(/Noto Naskh Arabic/);
    expect(notices).toMatch(/public\/fonts/);
  });
});
