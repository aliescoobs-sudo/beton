import { useTranslations } from 'next-intl';

export default function HomePage() {
  const t = useTranslations('shell');
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="mt-2 text-gray-600">{t('tagline')}</p>
    </main>
  );
}
