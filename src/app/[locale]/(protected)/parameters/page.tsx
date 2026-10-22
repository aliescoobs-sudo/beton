import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { z } from 'zod';
import { getPool } from '@/lib/db/pools';
import { can } from '@/modules/platform-security';
import { requirePagePermission } from '@/modules/platform-security/auth/page-guard';
import { PARAMETER_KEYS, PARAMETERS } from '@/modules/platform-security/domain/parameters';
import { readParameters } from '@/modules/platform-security/service/parameter-service';
import { type ParameterRow, ParametersForm } from '@/modules/platform-security/ui/parameters/parameters-form';
import { PageHeader } from '@/ui';

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
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t('title')} />
      <p className="mt-2 text-sm text-muted" data-testid="restart-note">
        {t('restartNote')}
      </p>
      <ParametersForm rows={rows} editable={can(user.role, 'parameters.write')} />
    </div>
  );
}
