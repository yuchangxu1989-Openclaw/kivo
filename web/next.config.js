/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/kivo',
  transpilePackages: ['@self-evolving-harness/kivo'],
  experimental: {
    serverComponentsExternalPackages: ['pdfjs-dist'],
    esmExternals: 'loose',
  },
  webpack: (config, { isServer }) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push('pdfjs-dist/legacy/build/pdf.mjs');
      config.externals.push('pdfjs-dist/build/pdf.worker.min.mjs');
    }
    // Ensure pdfjs-dist .mjs files are handled correctly
    config.resolve.alias = {
      ...config.resolve.alias,
      'pdfjs-dist/build/pdf.worker.min.mjs': false,
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; frame-src 'self';",
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: '/_next/static/chunks/app/(auth)/:path*',
        destination: '/_next/static/chunks/app/auth/:path*',
        permanent: false,
      },
      {
        source: '/_next/static/chunks/app/(dashboard)/:path*',
        destination: '/_next/static/chunks/app/dashboard/:path*',
        permanent: false,
      },
      {
        source: '/_next/static/chunks/app/(public)/:path*',
        destination: '/_next/static/chunks/app/public/:path*',
        permanent: false,
      },
      {
        source: '/',
        destination: '/kivo',
        basePath: false,
        permanent: false,
      },
      {
        source: '/login',
        destination: '/portal',
        permanent: false,
      },
      {
        source: '/login/simple',
        destination: '/portal',
        permanent: false,
      },
      {
        source: '/rules',
        destination: '/analytics/dispatch',
        permanent: false,
      },
      {
        source: '/dispatch',
        destination: '/analytics/dispatch',
        permanent: false,
      },
      {
        source: '/coverage',
        destination: '/analytics/coverage',
        permanent: false,
      },
      {
        source: '/utilization',
        destination: '/analytics/utilization',
        permanent: false,
      },
      {
        source: '/entries',
        destination: '/knowledge',
        permanent: false,
      },
      {
        source: '/entries/:path*',
        destination: '/knowledge/:path*',
        permanent: false,
      },
      {
        source: '/entry/:path*',
        destination: '/knowledge/:path*',
        permanent: false,
      },
      {
        source: '/dictionary',
        destination: '/settings/dictionary',
        permanent: false,
      },
      {
        source: '/glossary',
        destination: '/settings/dictionary',
        permanent: false,
      },
      {
        source: '/intent-governance',
        destination: '/settings/intents',
        permanent: false,
      },
      {
        // Redirect legacy /wiki/{spaceId}/{pageId} (UUID-shaped) into the SPA route
        // so dashboard / external links resolve. Sub-routes like /wiki/materials are untouched.
        source: '/wiki/:spaceId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/:pageId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
        destination: '/wiki?space=:spaceId&page=:pageId',
        permanent: false,
      },
      {
        source: '/wiki/:spaceId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
        destination: '/wiki?space=:spaceId',
        permanent: false,
      },
      {
        source: '/wiki',
        has: [{ type: 'query', key: 'view', value: 'graph' }],
        destination: '/graph',
        permanent: false,
      },
      {
        source: '/knowledge',
        has: [{ type: 'query', key: 'view', value: 'graph' }],
        destination: '/graph',
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;
