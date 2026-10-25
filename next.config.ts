import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  // A second build directory for the e2e run, so building never touches the one a running dev server uses.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  reactStrictMode: true,
  // Stop `next dev` from injecting its agent-rules block into CLAUDE.md/AGENTS.md.
  agentRules: false,
  // `next dev` prints every Server Function call with its arguments; never let that reach a terminal or a log file.
  logging: { serverFunctions: false },
  // Static assets bypass src/proxy.ts; give them the fixed hardening headers too.
  async headers() {
    return [
      {
        source: '/_next/static/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
