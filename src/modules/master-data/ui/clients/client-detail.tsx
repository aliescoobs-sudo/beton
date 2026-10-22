'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { archiveClientAction, updateClientAction } from './actions';
import { ClientForm, type ClientFormValues } from './client-form';

/** Edit form for one client, plus the archive button for owner/partner. Archived clients are shown read-only. */
export function ClientDetail({
  id,
  initial,
  archived,
  zones,
  canOverride,
  canArchive,
}: {
  id: string;
  initial: ClientFormValues;
  archived: boolean;
  zones: { id: string; name: string }[];
  canOverride: boolean;
  canArchive: boolean;
}) {
  const t = useTranslations('masterData.clients');
  const router = useRouter();
  const [error, setError] = useState(false);

  async function archive() {
    const result = await archiveClientAction(id);
    if (result.ok) return router.refresh();
    setError(true);
  }

  return (
    <div className="mt-6 space-y-4">
      {archived && (
        <p role="status" className="text-sm text-muted" data-testid="client-archived">
          {t('archivedNotice')}
        </p>
      )}
      {!archived && (
        <ClientForm
          initial={initial}
          zones={zones}
          submitLabel={t('save')}
          canOverride={canOverride}
          onSubmit={(input) => updateClientAction(id, input)}
          testId="client-edit"
        />
      )}
      {!archived && canArchive && (
        <button
          type="button"
          onClick={() => void archive()}
          className="btn btn-danger btn-sm"
          data-testid="client-archive"
        >
          {t('archive')}
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm">
          {t('error')}
        </p>
      )}
    </div>
  );
}
