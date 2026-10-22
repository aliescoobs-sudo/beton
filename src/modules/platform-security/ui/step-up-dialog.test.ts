import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import ar from '../../../../messages/ar.json';
import fr from '../../../../messages/fr.json';
import { StepUpDialog } from './step-up-dialog';

const KEYS = ['title', 'intro', 'code', 'confirm', 'cancel', 'invalid'] as const;
const catalogues = { fr, ar };

let current: 'fr' | 'ar' = 'fr';

// A missing key throws instead of rendering the raw path, which is how a blank/untranslated dialog would show.
vi.mock('next-intl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl')>()),
  useTranslations: (namespace: string) =>
    createTranslator({
      locale: current,
      messages: catalogues[current],
      namespace: namespace as never,
      onError: (error) => {
        throw error;
      },
    }),
}));

function render(locale: 'fr' | 'ar') {
  current = locale;
  return renderToStaticMarkup(createElement(StepUpDialog, { onVerified: () => {}, onCancel: () => {} }));
}

describe('StepUpDialog', () => {
  for (const locale of ['fr', 'ar'] as const) {
    it(`has every auth.stepUp key in ${locale}, non-empty`, () => {
      for (const key of KEYS) expect(catalogues[locale].auth.stepUp[key]?.trim(), key).toBeTruthy();
    });

    it(`renders translated text, no raw key, in ${locale}`, () => {
      const html = render(locale);
      for (const key of ['title', 'intro', 'code', 'confirm', 'cancel'] as const) {
        expect(html).toContain(catalogues[locale].auth.stepUp[key].replace(/'/g, '&#x27;'));
      }
      expect(html).not.toContain('auth.stepUp');
    });

    it(`sets its own text colour in ${locale} (it is rendered inside the simulation pill's popover)`, () => {
      expect(render(locale)).toMatch(/role="dialog"[^>]*class="[^"]*\btext-ink\b/);
    });
  }
});
