import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { z } from 'zod';
import { getPool } from '@/lib/db/pools';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/auth/page-guard';
import { PARAMETER_KEYS, PARAMETERS } from '@/modules/platform-security/domain/parameters';
import { readParameters } from '@/modules/platform-security/service/parameter-service';
import { type ParameterRow, ParametersForm } from '@/modules/platform-security/ui/parameters/parameters-form';

function bounds(schema: z.ZodType): { min?: number; max?: number } {
  const def = schema as unknown as { minValue?: number | null; maxValue?: number | null };
  return { min: def.minValue ?? undefined, max: def.maxValue ?? undefined };
}

export default async function ParametersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await requirePagePermission(locale, 'parameters.read');
  const values = await readParameters(getPool('auth'));
  const rows: ParameterRow[] = PARAMETER_KEYS.map((key) => {
    const value = values[key];
    return typeof value === 'number'
      ? { key, value, kind: 'number', ...bounds(PARAMETERS[key].schema) }
      : { key, value, kind: 'time' };
  });
  const t = await getTranslations('parameters');
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-2 text-sm text-gray-600" data-testid="restart-note">
        {t('restartNote')}
      </p>
      <ParametersForm rows={rows} editable={can(user.role, 'parameters.write')} />
    </main>
  );
}
