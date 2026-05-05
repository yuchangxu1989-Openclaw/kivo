/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/kivo',
  transpilePackages: ['@self-evolving-harness/kivo'],
  serverExternalPackages: ['pdfjs-dist'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/kivo/dashboard',
        basePath: false,
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
    ];
  },
};

module.exports = nextConfig;
