'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createClientAction } from './actions';
import { ClientForm, EMPTY_CLIENT } from './client-form';

export interface ClientListRow {
  id: string;
  code: string;
  name: string;
  kind: 'company' | 'person';
  status: 'active' | 'archived';
}

/** Office, owner and partner create and edit; plant never reaches this page (404 at the route). */
export function ClientsManager({
  clients,
  zones,
  locale,
  canOverride,
}: {
  clients: ClientListRow[];
  zones: { id: string; name: string }[];
  locale: string;
  canOverride: boolean;
}) {
  const t = useTranslations('masterData.clients');
  return (
    <div className="mt-6 space-y-6">
      <section className="rounded border border-dashed border-gray-300 p-3">
        <h2 className="mb-2 font-medium">{t('new')}</h2>
        <ClientForm
          initial={EMPTY_CLIENT}
          zones={zones}
          submitLabel={t('add')}
          canOverride={canOverride}
          onSubmit={createClientAction}
          testId="client-new"
        />
      </section>
      <ul className="space-y-2">
        {clients.map((client) => (
          <li
            key={client.id}
            className="flex flex-wrap items-center gap-x-6 rounded border border-gray-200 p-3"
            data-testid={`client-${client.name}`}
          >
            <span dir="ltr" className="font-mono text-sm">
              {client.code}
            </span>
            <Link href={`/${locale}/master-data/clients/${client.id}`} className="font-medium underline">
              <bdi>{client.name}</bdi>
            </Link>
            <span className="text-sm text-gray-600">
              {client.kind === 'company' ? t('kindCompany') : t('kindPerson')}
            </span>
            {client.status === 'archived' && (
              <span className="text-sm text-gray-600" data-testid="client-archived">
                {t('archivedBadge')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
