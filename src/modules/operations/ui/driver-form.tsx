'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button, Input } from '@/ui';

/** A manager adds a driver by name; the code CH-nn is given by the service. */
export function DriverForm({
  create,
}: {
  create: (input: unknown) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useTranslations('operations.dispatch');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '');
    setPending(true);
    setMessage(null);
    try {
      const result = await create({ name });
      if (!result.ok) return setMessage(t('driverError'));
      form.reset();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" data-testid="driver-form">
      <label className="block">
        <span className="field-label">{t('driverName')}</span>
        <Input name="name" required maxLength={80} data-testid="driver-name" />
      </label>
      <Button type="submit" variant="secondary" disabled={pending} data-testid="driver-add">
        {t('driverAdd')}
      </Button>
      {message && (
        <span role="alert" className="text-sm text-danger">
          {message}
        </span>
      )}
    </form>
  );
}
