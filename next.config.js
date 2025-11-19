/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Enable standalone output for Docker
  experimental: {
    instrumentationHook: true, // Enable instrumentation hook for workers
    serverComponentsExternalPackages: ['ts-node'], // Don't bundle ts-node
  },
  
  // Configure webpack to exclude worker files and ts-node from bundling
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Exclude ts-node and worker files from server-side bundling
      const originalExternals = config.externals || [];
      config.externals = [
        ...(Array.isArray(originalExternals) ? originalExternals : [originalExternals]),
        {
          'ts-node': 'commonjs ts-node',
          'ts-node/register': 'commonjs ts-node/register',
        },
        // Exclude worker files from bundling - they'll be loaded at runtime
        (context, request, callback) => {
          if (request && request.includes('lib/worker/')) {
            return callback(null, `commonjs ${request}`);
          }
          callback();
        },
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

