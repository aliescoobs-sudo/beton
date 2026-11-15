import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, EmptyState, Money, PageHeader, StatusPill, Table, Td, Th } from './index';

describe('design tokens', () => {
  const tokensCss = readFileSync('src/app/tokens.css', 'utf8');
  const css = `${tokensCss}\n${readFileSync('src/app/globals.css', 'utf8')}`;
  it.each([
    ['forest', '#01592b'],
    ['citron', '#9ada02'],
    ['graphite', '#292929'],
    ['craie', '#f5f5f5'],
    ['canvas', '#f5f5f5'],
    ['ink', '#292929'],
    ['heading', '#01592b'],
  ])('--color-%s is the KAYAS brand value %s', (name, hex) => {
    expect(css).toContain(`--color-${name}: ${hex};`);
  });

  it.each([
    ['signal', '#d23a1e'],
    ['ok', '#2f6b4f'],
    ['amber', '#c08a12'],
    ['sim', '#5b45a8'],
    ['status-paid', '#2e7d4f'],
    ['status-ontrack', '#2f6db5'],
    ['status-due', '#c9a227'],
    ['status-late', '#c0392b'],
    ['status-cancelled', '#8a8f98'],
  ])('--color-%s is %s (D21/D22 status colours unchanged by the rebrand)', (name, hex) => {
    expect(css).toContain(`--color-${name}: ${hex};`);
  });

  it('is flat: no shadow, control radius 6px, no tinted status background, tabular numerals on the page', () => {
    expect(css).not.toMatch(/box-shadow|--shadow/);
    expect(css).toContain('--radius-control: 6px;');
    expect(css).toMatch(/html \{[^}]*font-variant-numeric: tabular-nums/);
    const pill = css.slice(css.indexOf('.pill {'), css.indexOf('.pill::before'));
    expect(pill).not.toMatch(/background|border:/);
    expect(css.slice(css.indexOf('.pill::before'), css.indexOf('.pill-paid'))).toContain('inline-size: 10px');
  });

  it('uses the bundled KAYAS fonts, self-hosted: Inter for Latin and numbers first, Noto Naskh Arabic for Arabic, no external font', () => {
    expect(css).toMatch(/--font-sans:\s*'KAYAS Inter', 'KAYAS Naskh', system-ui/);
    expect(css).toContain("url('/fonts/kayas-font-latin-variable.ttf')");
    expect(css).toContain("url('/fonts/kayas-font-arabic-variable.ttf')");
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/https?:\/\/|@import url|fonts\.googleapis|Helvetica Neue|Geeza/);
    for (const f of ['latin', 'arabic']) {
      expect(readFileSync(`public/fonts/kayas-font-${f}-variable.ttf`).length).toBeGreaterThan(100_000);
      expect(readFileSync(`public/fonts/kayas-font-${f}-license.txt`, 'utf8')).toMatch(
        /SIL OPEN FONT LICENSE/i,
      );
    }
  });

  it('one tokens file carries spacing, radius, the type scale (body 16 px, line height 1.5) and the focus ring; globals reads it', () => {
    for (const name of [
      '--space-4',
      '--radius-control',
      '--text-body',
      '--leading-body',
      '--focus-width',
      '--touch-target',
    ])
      expect(tokensCss).toContain(`${name}:`);
    expect(tokensCss).toContain('--text-body: 1rem;');
    expect(tokensCss).toContain('--leading-body: 1.5;');
    const globals = readFileSync('src/app/globals.css', 'utf8');
    expect(globals).toContain("@import './tokens.css'");
    expect(globals).toContain('prefers-reduced-motion: reduce');
    // no colour value is declared outside the tokens file except the fixed button hover and the overlay scrim
    expect(globals.replace(/\/\*[\s\S]*?\*\//g, '').match(/--color-[a-z-]+:/g)).toBeNull();
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
