'use client';

import { useTranslations } from 'next-intl';
import { ErrorState } from '@/ui';

/** The error state of every signed-in screen: words, a retry, no technical detail (T18-UI C). */
export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('list');
  return (
    <ErrorState
      title={t('errorTitle')}
      description={t('errorBody')}
      retryLabel={t('retry')}
      digest={error.digest}
      onRetry={reset}
    />
  );
}
