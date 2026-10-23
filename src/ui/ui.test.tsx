import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from './index';

describe('design tokens', () => {
  const css = readFileSync('src/app/globals.css', 'utf8');
  it.each([
    ['canvas', '#e6e7e3'],
    ['surface', '#f4f4f1'],
    ['band', '#d5d7d2'],
    ['ink', '#1b1d1c'],
    ['muted', '#5e6360'],
    ['rule', '#bfc2bd'],
    ['field', '#8d918c'],
    ['signal', '#d23a1e'],
    ['ok', '#2f6b4f'],
    ['amber', '#c08a12'],
    ['sim', '#5b45a8'],
    ['sim-past', '#b9bcb7'],
    ['status-paid', '#2e7d4f'],
    ['status-ontrack', '#2f6db5'],
    ['status-due', '#c9a227'],
    ['status-late', '#c0392b'],
    ['status-cancelled', '#8a8f98'],
  ])('--color-%s is %s (D21/D22 status colours unchanged)', (name, hex) => {
    expect(css).toContain(`--color-${name}: ${hex};`);
  });

  it('is flat: no shadow, control radius 2px, no tinted status background, tabular numerals on the page', () => {
    expect(css).not.toMatch(/box-shadow|--shadow/);
    expect(css).toContain('--radius-control: 2px;');
    expect(css).toMatch(/html \{[^}]*font-variant-numeric: tabular-nums/);
    const pill = css.slice(css.indexOf('.pill {'), css.indexOf('.pill::before'));
    expect(pill).not.toMatch(/background|border:/);
    expect(css.slice(css.indexOf('.pill::before'), css.indexOf('.pill-paid'))).toContain('inline-size: 10px');
  });

  it('loads Alexandria for titles and Readex Pro for text, from committed files', () => {
    expect(css).toMatch(/--font-display:\s*var\(--font-alexandria-latin\)/);
    expect(css).toMatch(/--font-sans:\s*var\(--font-readex-latin\)/);
    for (const f of ['Alexandria-latin', 'Alexandria-arabic', 'ReadexPro-latin', 'ReadexPro-arabic']) {
      expect(readFileSync(`src/fonts/${f}-variable.woff2`).length).toBeGreaterThan(10_000);
    }
  });

  it('components use logical properties only (no left/right/margin-left in globals.css)', () => {
    const components = css.slice(css.indexOf('@layer components'));
    expect(components).not.toMatch(
      /\b(margin|padding|border)-(left|right)\b|\b(left|right):|text-align:\s*(left|right)/,
    );
  });
});

describe('kit', () => {
  it('Button defaults to type="button" and carries the variant class', () => {
    expect(renderToStaticMarkup(<Button>ok</Button>)).toContain('type="button"');
    expect(
      renderToStaticMarkup(
        <Button variant="danger" small>
          x
        </Button>,
      ),
    ).toMatch(/btn btn-danger btn-sm/);
  });

  it('StatusPill marks its status (colour comes from the token class)', () => {
    const html = renderToStaticMarkup(<StatusPill status="late">En retard</StatusPill>);
    expect(html).toContain('pill-late');
    expect(html).toContain('En retard');
  });

  it('numeric table cells align to the inline end and isolate their content left-to-right', () => {
    const html = renderToStaticMarkup(
      <Table>
        <thead>
          <tr>
            <Th numeric>Montant</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td numeric>1 234,56</Td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(html).toContain('is-num');
    expect(html).toContain('<bdi dir="ltr">1 234,56</bdi>');
  });

  it('Money shows 1 234,56 MAD with Latin digits, left-to-right', () => {
    expect(renderToStaticMarkup(<Money centimes={123_456} />)).toBe(
      '<bdi dir="ltr" class="num">1 234,56 MAD</bdi>',
    );
  });

  it('PageHeader renders the one h1; EmptyState a title and description', () => {
    expect(renderToStaticMarkup(<PageHeader title="Clients" description="d" />)).toContain('<h1');
    const empty = renderToStaticMarkup(<EmptyState title="Rien" description="Bientôt" />);
    expect(empty).toContain('Rien');
    expect(empty).toContain('Bientôt');
  });
});
