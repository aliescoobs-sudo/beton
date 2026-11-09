import { notFound } from 'next/navigation';

/** Any address under a locale that matches no page: handed to the branded not-found page (inside the locale layout, so fr/ar/RTL are right). */
export default function UnknownPage() {
  notFound();
}
