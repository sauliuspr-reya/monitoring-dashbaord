/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Enable standalone output for Docker
  experimental: {
    instrumentationHook: true, // Enable instrumentation hook for workers
  },
  
  // Configure webpack to exclude server-only packages from bundling
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Mark pg and related packages as external - don't bundle them
      // They'll be loaded from node_modules at runtime
      config.externals = [
        ...config.externals,
        'pg',
        'pg-native',
        'pg-hstore',
      ];
    }
    return config;
  },
  
  // Rewrite /healthz to /api/healthz for Kubernetes probes
  async rewrites() {
    return [
      {
        source: '/healthz',
        destination: '/api/healthz',
      },
    ];
  },
  
  // Disable all caching for real-time replication monitoring
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate, max-age=0' },
        ],
      },
    ];
  },
}

module.exports = nextConfig

